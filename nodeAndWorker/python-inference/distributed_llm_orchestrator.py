"""
Orchestrateur Pipeline Parallelism — Vryx DePIN.

Côté VPS / Initiateur :
 1. Charge uniquement le tokenizer/config et garde les poids HF sur disque.
 2. À chaque session d'inférence, découpe les couches en N tranches et pousse
    chaque tranche au worker correspondant via /api/p2p/relay (vryx.shard.*).
 3. Lance la boucle autorégressive :
      - Tokenise le prompt → token_ids
      - Envoie à worker 1 via routing_path=[w1, w2, w3]
      - Le daemon Rust fait transiter les hidden_states de worker en worker
      - Reçoit le next_token_id du dernier worker
      - Dé-tokenise et boucle jusqu'à EOS ou MAX_NEW_TOKENS

Variables :
  VRYX_DIST_MODEL          Modèle HuggingFace (défaut : Qwen/Qwen3.5-9B — aligné VPS prod)
  VRYX_DIST_MAX_TOKENS     Tokens max générés (défaut : 512)
  VRYX_P2P_RELAY_URL       URL du daemon Rust initiateur (défaut : http://127.0.0.1:3031)
  VRYX_DIST_MAX_WORKERS    Workers max utilisés dans la Daisy Chain lorsque tous les compatibles sont pris sans surcoût dédié ; voir aussi VRYX_DIST_USE_ALL_COMPATIBLE_PEERS.
  VRYX_DIST_USE_ALL_COMPATIBLE_PEERS  1 = utiliser jusqu’à VRYX_DIST_HARD_CAP_PEERS workers parmi les pairs découverts (après match modèle) pour répartir toutes les couches (test mono-machine multi-process ; pas de mini-plafond 2 pour les 0.5B).

  VRYX_DIST_HARD_CAP_PEERS   Plafond de sécurité si USE_ALL_PEERS vaut 1 (défaut 48).
  VRYX_DIST_SINGLE_NODE_PUBLIC_IP    Si défini : ne garder que les peers dont le heartbeat (catalog) expose ce publicIp (même foyer / même Mac plusieurs workers).

  VRYX_DIST_MIN_WORKERS    Workers minimum pour lancer une session (défaut : 1 = un seul Mac suffit ;
                           toutes les couches sur ce nœud. Mettre 2 ou 3 en prod pour la Daisy Chain 9B.)
  VRYX_HOT_POOL_MAX_RTT_MS Score hot-pool (défaut 2000 ms, adapté au WAN)
  VRYX_DIST_TIMEOUT_SEC    Plafond client HTTP orchestrateur → relais / petits hops (défaut : 600)
  VRYX_PIPELINE_STEP_TIMEOUT_SEC  Budget par étape pipeline (prefill/décode) ; défaut max(VRYX_DIST_TIMEOUT_SEC, 600)
  VRYX_PIPELINE_CHAIN_MODE  Topologie relay : défaut initiator_sequential (chaîne Worker1→Worker2 sans repasser par le VPS).
  VRYX_HIDDEN_MICROCHUNK_BYTES  Réservation proto : payload stream (hint micro-chunks, 0 = désactivé).
  VRYX_DECODE_MICROBATCH     Défaut 1 : avec un seul worker (embedding+lm_head) et greedy (temperature≤0),
                             demander jusqu’à VRYX_DECODE_MICROBATCH_CAP jetons locaux avant le prochain relay WAN.
  VRYX_DECODE_MICROBATCH_CAP Défaut 32 ; plafond par aller-retour (max 64).
  VRYX_CONTINUOUS_BATCHING  Mettre à 1 pour max débit système ; ajuster VRYX_BATCH_WINDOW_MS selon RTT groupe.
  VRYX_SHARD_READY_POLL_SEC  Intervalle (s) entre deux sondes « shard ready » après init (défaut 0.75 ; plage 0.15–5).
  VRYX_SHARD_READY_POLL_SLOW_SEC  Après N itérations, intervalle plus long (défaut 5 ; ≥ fast).
  VRYX_SHARD_READY_POLL_SLOW_AFTER  Nombre d’itérations rapides avant le mode lent (défaut 45).
  VRYX_PARALLEL_SHARD_INIT  1 = init relais + attente ready en parallèle (max 2 workers par défaut) après extraction disque séquentielle ; risque RAM/I/O VPS.
  VRYX_PARALLEL_SHARD_INIT_MAX  File ThreadPool (1–4, défaut 2).
  VRYX_SHARD_DOWNLOAD_BASE_URL  Base HTTPS des URLs « download_url » dans les manifests (doit être joignable depuis les workers distants). Prioritaire sur VRYX_API_URL pour les shards uniquement.
  VRYX_SHARD_DOWNLOAD_FALLBACK   Si VRYX_API_URL est 127.0.0.1 / RFC1918 sans base explicite : hôte public utilisé pour les URLs (défaut https://vryx.eu).
  VRYX_API_URL                  Base publique (heartbeat) ; sert aussi au secours découverte/catalogue quand tp-peers ou :4000 sont vides.
  VRYX_DIST_PUBLIC_REGISTRY_PEERS  Défaut 1 : si aucun pair local/tp-peers, interroger GET {VRYX_API_URL}/api/workers/status (workers + même modèle).
  VRYX_PUBLIC_WORKER_CATALOG      Défaut 1 : catalogue placement (VRAM, runtime) depuis la même route si :48953/:4000 échouent.
  VRYX_MLX_ALLOW_Q4_HIDDEN   Si 1, autorise transport hidden q4/int8 avec pool velocity_mlx ; sinon ils sont ramenés à fp16 (qualité des logits).
  VRYX_FULL_WORKER_RTT_MATRIX  Si 1, mesure tous les pings worker↔worker (exact mais lent). Défaut 0 : estimation via RTT VPS→workers (cold setup bien plus rapide).

"""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import urllib.error
import urllib.request

import numpy as np

from batching import BatchQueue, batching_trace

# ── Config ─────────────────────────────────────────────────────────────────────

MODEL_ID = os.environ.get("VRYX_DIST_MODEL", "Qwen/Qwen3.5-9B")
MAX_NEW_TOKENS = int(os.environ.get("VRYX_DIST_MAX_TOKENS", "512"))
RELAY_URL = os.environ.get("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031").rstrip("/")
DECODE_MICROBATCH = os.environ.get("VRYX_DECODE_MICROBATCH", "1").strip().lower() not in ("0", "false", "no", "off")
try:
    DECODE_MICROBATCH_CAP = max(2, min(64, int(os.environ.get("VRYX_DECODE_MICROBATCH_CAP", "32") or "32")))
except (TypeError, ValueError):
    DECODE_MICROBATCH_CAP = 32
MLX_LM_DIRECT = os.environ.get("VRYX_MLX_LM_DIRECT", "0").strip().lower() in ("1", "true", "yes", "on")

RELAY_TLS = threading.local()


def _default_max_workers_for_model() -> int:
    """Plafond modeste par défaut selon la taille HF (évite de sur-découper à froid).

    En pratique tu peux soit fixer ``VRYX_DIST_MAX_WORKERS``, soit activer
    ``VRYX_DIST_USE_ALL_COMPATIBLE_PEERS`` pour couvrir les ``num_hidden_layers``
    sur autant de peers actifs que nécessaire (plafond ``VRYX_DIST_HARD_CAP_PEERS``).
    """
    m = MODEL_ID.lower()
    # Éviter de matcher « 3.5 » comme « 3b » : on teste les plus petits en premier avec des motifs précis.
    if any(x in m for x in ("0.5b", "0.6b", "1.5b", "qwen2.5-0.5b", "qwen2.5-1.5b")):
        return 2
    if re.search(r"\b1b\b", m) or re.search(r"\b2b\b", m) or re.search(r"-3b\b", m):
        return 2
    if any(x in m for x in ("72b", "70b", "65b", "405b")):
        return 8
    return 3


_DEFAULT_MAX_WORKERS = _default_max_workers_for_model()
MAX_WORKERS = max(1, int(os.environ.get("VRYX_DIST_MAX_WORKERS", str(_DEFAULT_MAX_WORKERS))))
# Défaut 1 : un seul worker MLX sur Mac (RAM unifiée) peut porter tout le pipeline pour le 9B.
# Pour forcer 3 hops : export VRYX_DIST_MIN_WORKERS=3
try:
    _min_default = int(str(os.environ.get("VRYX_DIST_MIN_WORKERS", "1") or "1").strip())
except ValueError:
    _min_default = 1
MIN_WORKERS = max(1, min(_min_default, MAX_WORKERS))


def _filter_workers_by_catalog_public_ip_optional(peers: list[str], catalog: dict[str, dict]) -> list[str]:
    """Restreindre aux workers annonçant la même IP publique (plusieurs daemon sur une machine)."""
    ip_needle = os.environ.get("VRYX_DIST_SINGLE_NODE_PUBLIC_IP", "").strip()
    if not ip_needle or not peers:
        return peers
    out = []
    for p in peers:
        row = catalog.get(p) or {}
        pub = str(row.get("publicIp") or row.get("public_ip") or "").strip()
        if pub == ip_needle:
            out.append(p)
    if not out:
        print(
            f"[VPS] Filtre mono-nœud : aucun peer parmi {len(peers)} n’a publicIp={ip_needle!r} dans le catalogue. "
            "Vérifiez les heartbeats / la base.",
        )
        return peers
    if len(out) != len(peers):
        print(f"[VPS] Filtre mono-nœud publicIp={ip_needle} : conservation de {len(out)}/{len(peers)} peers")
    return out


def _routing_pipeline_width(peers_online: int) -> int:
    """Nombre maximal de peers embarqués pour couvrir num_hidden_layers_total (avec plafonds)."""
    peers_online = max(0, int(peers_online))
    use_all = os.environ.get("VRYX_DIST_USE_ALL_COMPATIBLE_PEERS", "").strip().lower() in ("1", "true", "yes")
    if use_all:
        try:
            cap = int(float(os.environ.get("VRYX_DIST_HARD_CAP_PEERS", "48") or 48))
        except (TypeError, ValueError):
            cap = 48
        cap = max(cap, MIN_WORKERS)
        width = min(peers_online, cap)
        print(f"[VPS] Daisy Chain largeur dynamique USE_ALL_COMPATIBLE_PEERS → {width} peer(s) (cap={cap}, en ligne={peers_online})")
        return width
    return min(peers_online, MAX_WORKERS)


def _timeout_sec(name: str, default: float, floor: float = 600.0) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None else float(default)
    except (TypeError, ValueError):
        value = float(default)
    return max(value, floor)


TIMEOUT = _timeout_sec("VRYX_DIST_TIMEOUT_SEC", 600.0)
# Une étape pipeline (surtout prefill MLX froid) peut dépasser 240 s ; ne plus plafonner à 240.
# Si un override prod est resté à 120 s, on garde un plancher runtime à 600 s.
PIPELINE_STEP_TIMEOUT = _timeout_sec("VRYX_PIPELINE_STEP_TIMEOUT_SEC", max(TIMEOUT, 600.0))
SHARD_INIT_TIMEOUT = _timeout_sec("VRYX_SHARD_INIT_TIMEOUT_SEC", 600.0)
SHARD_LOAD_TIMEOUT = _timeout_sec("VRYX_SHARD_LOAD_TIMEOUT_SEC", 600.0)
SHARD_BUILD_TIMEOUT = _timeout_sec("VRYX_SHARD_BUILD_TIMEOUT_SEC", 600.0)
SHARD_STATUS_TIMEOUT = _timeout_sec("VRYX_SHARD_STATUS_TIMEOUT_SEC", 120.0, floor=20.0)
SHARD_TTL = int(os.environ.get("VRYX_DIST_SHARD_TTL", "1800"))
POOL_TTL = int(os.environ.get("VRYX_POOL_TTL_SEC", str(max(SHARD_TTL, 24 * 3600))))
KEEP_POOL_SHARDS = os.environ.get("VRYX_POOL_KEEP_SHARDS", "true").lower() not in ("0", "false", "no")
POOL_REPLICATION_FACTOR = max(0, int(os.environ.get("VRYX_POOL_REPLICATION_FACTOR", "1")))
SHARD_BASE_DIR = os.environ.get("VRYX_SHARD_BASE_DIR", "/var/tmp/vryx-shards")
# WAN / relais : 25 ms exclut la plupart des workers domicile → défaut plus large (override possible).
HOT_POOL_MAX_RTT_MS = float(os.environ.get("VRYX_HOT_POOL_MAX_RTT_MS", "2000"))
HOT_POOL_IDEAL_RTT_MS = float(os.environ.get("VRYX_HOT_POOL_IDEAL_RTT_MS", "80"))
HIDDEN_TRANSPORT = os.environ.get("VRYX_HIDDEN_TRANSPORT", "int8").lower()
PIPELINE_STREAM_MODE = os.environ.get("VRYX_PIPELINE_STREAM_MODE", "hot_session").lower()
WORKER_KV_CACHE = os.environ.get("VRYX_WORKER_KV_CACHE", "true").lower() not in ("0", "false", "no")
SAMPLING_TEMPERATURE = float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0.35"))
SAMPLING_TOP_P = float(os.environ.get("VRYX_SAMPLING_TOP_P", "0.75"))
SAMPLING_TOP_K = int(os.environ.get("VRYX_SAMPLING_TOP_K", "20"))
REPETITION_PENALTY = float(os.environ.get("VRYX_REPETITION_PENALTY", "1.0"))
REPETITION_GUARD = os.environ.get("VRYX_REPETITION_GUARD", "true").lower() not in ("0", "false", "no")
HIDDEN_QUIC = os.environ.get("VRYX_HIDDEN_QUIC", "0").lower() in ("1", "true", "yes")
PREFIX_CACHE = os.environ.get("VRYX_PREFIX_CACHE", "1").lower() not in ("0", "false", "no")
PREFIX_CACHE_TTL_SEC = int(os.environ.get("VRYX_PREFIX_CACHE_TTL_SEC", str(24 * 3600)))
PREFIX_CACHE_MIN_TOKENS = int(os.environ.get("VRYX_PREFIX_CACHE_MIN_TOKENS", "32"))
PREFIX_CACHE_DIR = os.environ.get("VRYX_PREFIX_CACHE_DIR", os.path.join(SHARD_BASE_DIR, "prefix-cache"))
SPECULATIVE_HEADS = os.environ.get("VRYX_SPECULATIVE_HEADS", "off").lower()
CONTINUOUS_BATCHING = os.environ.get("VRYX_CONTINUOUS_BATCHING", "0").lower() in ("1", "true", "yes")
BATCH_MAX_SIZE = max(1, int(os.environ.get("VRYX_BATCH_MAX_SIZE", "8")))
BATCH_WINDOW_MS = max(
    1,
    int(os.environ.get("VRYX_BATCH_WINDOW_MS", "24" if CONTINUOUS_BATCHING else "10")),
)
CHUNKED_PREFILL = os.environ.get("VRYX_CHUNKED_PREFILL", "0").lower() in ("1", "true", "yes")
PREFILL_CHUNK_TOKENS = int(os.environ.get("VRYX_PREFILL_CHUNK_TOKENS", "512"))
RING_ATTENTION = os.environ.get("VRYX_RING_ATTENTION", "0").lower() in ("1", "true", "yes")
PIPELINE_OVERLAP = os.environ.get("VRYX_PIPELINE_OVERLAP", "0").lower() in ("1", "true", "yes")
PERSISTENT_RELAY = os.environ.get("VRYX_PERSISTENT_RELAY", "1").lower() not in ("0", "false", "no")
PIPELINE_CHAIN_MODE = os.environ.get("VRYX_PIPELINE_CHAIN_MODE", "initiator_sequential").strip().lower()
HIDDEN_MICROCHUNK_BYTES = max(0, int(os.environ.get("VRYX_HIDDEN_MICROCHUNK_BYTES", "0")))
POOL_PREFERENCE_DEFAULT = os.environ.get("VRYX_POOL_PREFERENCE", "auto").lower()
REQUIRE_WORKER_MODEL_MATCH = os.environ.get("VRYX_REQUIRE_WORKER_MODEL_MATCH", "true").lower() not in ("0", "false", "no")
_PUBLIC_REGISTRY_PEER_DISCOVERY = os.environ.get(
    "VRYX_DIST_PUBLIC_REGISTRY_PEERS", "1",
).strip().lower() not in ("0", "false", "no", "off")
_PUBLIC_WORKER_CATALOG = os.environ.get(
    "VRYX_PUBLIC_WORKER_CATALOG", "1",
).strip().lower() not in ("0", "false", "no", "off")

try:
    _SHARD_READY_POLL_FAST = max(
        0.15,
        min(5.0, float(os.environ.get("VRYX_SHARD_READY_POLL_SEC", "0.75"))),
    )
except ValueError:
    _SHARD_READY_POLL_FAST = 0.75
try:
    _SHARD_READY_POLL_SLOW = max(
        _SHARD_READY_POLL_FAST,
        min(30.0, float(os.environ.get("VRYX_SHARD_READY_POLL_SLOW_SEC", "5"))),
    )
except ValueError:
    _SHARD_READY_POLL_SLOW = 5.0
try:
    _SHARD_READY_POLL_SLOW_AFTER = max(
        1,
        min(500, int(os.environ.get("VRYX_SHARD_READY_POLL_SLOW_AFTER", "45"))),
    )
except ValueError:
    _SHARD_READY_POLL_SLOW_AFTER = 45

PARALLEL_SHARD_INIT = os.environ.get("VRYX_PARALLEL_SHARD_INIT", "1").lower() not in ("0", "false", "no")
try:
    PARALLEL_SHARD_INIT_MAX = max(
        1,
        min(8, int(os.environ.get("VRYX_PARALLEL_SHARD_INIT_MAX", "4"))),
    )
except ValueError:
    PARALLEL_SHARD_INIT_MAX = 4


def _use_full_worker_rtt_matrix() -> bool:
    return os.environ.get("VRYX_FULL_WORKER_RTT_MATRIX", "").strip().lower() in ("1", "true", "yes")


def _worker_shard_download_base_url() -> str:
    """
    Hôte pour les URLs binaire/manifeste envoyées aux workers (téléchargement HTTPS).
    Si VRYX_API_URL pointe vers localhost ou un réseau privé, les workers distants ne peuvent pas
    joindre ces chemins : on retombe sur un hôte public configurable.
    """
    explicit = (
        os.environ.get("VRYX_SHARD_DOWNLOAD_BASE_URL") or os.environ.get("VRYX_PUBLIC_API_URL") or ""
    ).strip().rstrip("/")
    if explicit:
        return explicit
    cand = (os.environ.get("VRYX_API_URL") or "https://vryx.eu").strip().rstrip("/")
    private_re = re.compile(
        r"^https?://(127\.0\.0\.1|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)",
        re.I,
    )
    if private_re.match(cand):
        fb = (os.environ.get("VRYX_SHARD_DOWNLOAD_FALLBACK") or "https://vryx.eu").strip().rstrip("/")
        print(
            f"[VPS] Shards : VRYX_API_URL={cand!r} n'est pas joignable depuis les workers distants ; "
            f"URLs de téléchargement basées sur {fb!r}. "
            f"Pour forcer : export VRYX_SHARD_DOWNLOAD_BASE_URL=https://… (même origine que GET /api/internal/shard-serve/…)."
        )
        return fb
    return cand


def _shard_ready_sleep_sec(poll_n: int) -> float:
    return (
        _SHARD_READY_POLL_SLOW
        if poll_n > _SHARD_READY_POLL_SLOW_AFTER
        else _SHARD_READY_POLL_FAST
    )


_latency_cache: dict[str, dict[str, Any]] = {}
_latency_lock = threading.Lock()
_prefix_cache_lock = threading.Lock()


def _normalize_hidden_transport(value: Any) -> str:
    requested = str(value or HIDDEN_TRANSPORT or "int8").strip().lower()
    aliases = {
        "4bit": "q4",
        "4-bit": "q4",
        "q4": "q4",
        "int4": "q4",
        "8bit": "int8",
        "8-bit": "int8",
        "int8": "int8",
        "fp16": "fp16",
        "fp32": "fp32",
    }
    return aliases.get(requested, "int8")


def _normalize_pool_preference(value: Any) -> str:
    requested = str(value or POOL_PREFERENCE_DEFAULT or "auto").strip().lower()
    if requested in ("velocity", "mlx", "velocity_mlx"):
        return "velocity_mlx"
    if requested in ("legacy", "pytorch", "legacy_pytorch"):
        return "legacy_pytorch"
    if requested in ("vllm", "velocity_vllm"):
        return "velocity_vllm"
    return "auto"


def _worker_pool_class(worker: dict[str, Any]) -> str:
    runtime = str(worker.get("runtimeBackend") or worker.get("runtime_backend") or "pytorch").lower()
    supports_mlx = bool(worker.get("supportsMlx") or worker.get("supports_mlx"))
    supports_vllm = bool(worker.get("supportsVllm") or worker.get("supports_vllm"))
    if runtime == "mlx" and supports_mlx:
        return "velocity_mlx"
    if runtime == "vllm" and supports_vllm:
        return "velocity_vllm"
    return "legacy_pytorch"


def _runtime_for_pool(pool_class: str, worker: dict[str, Any] | None = None) -> str:
    if pool_class == "velocity_mlx":
        return "mlx"
    if pool_class == "velocity_vllm":
        return "vllm"
    return str((worker or {}).get("runtimeBackend") or (worker or {}).get("runtime_backend") or "pytorch").lower()


def _attention_for_pool(pool_class: str) -> str:
    if pool_class == "velocity_mlx":
        return "mlx_metal"
    if pool_class == "velocity_vllm":
        return "paged_attention"
    return "pytorch"


def _model_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", "-")


def _worker_matches_model(worker: dict[str, Any], model_id: str = MODEL_ID) -> bool:
    advertised = _model_key(worker.get("model") or worker.get("model_id"))
    expected = _model_key(model_id)
    if not advertised:
        return False
    return advertised == expected or advertised.endswith("/" + expected.split("/")[-1])


def _public_api_base() -> str:
    return (os.environ.get("VRYX_API_URL") or "https://vryx.eu").strip().rstrip("/")


def _fetch_workers_public_status_payload() -> list[dict]:
    try:
        url = f"{_public_api_base()}/api/workers/status"
        req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []
    workers = body.get("workers") if isinstance(body, dict) else []
    return [w for w in workers if isinstance(w, dict)]


def _peers_public_registry_live() -> list[str]:
    if not _PUBLIC_REGISTRY_PEER_DISCOVERY:
        return []
    out: list[str] = []
    for w in _fetch_workers_public_status_payload():
        if str(w.get("mode") or "").lower() != "worker":
            continue
        pid = str(w.get("peerId") or w.get("peer_id") or "").strip()
        if not pid:
            continue
        if REQUIRE_WORKER_MODEL_MATCH and not _worker_matches_model(w):
            continue
        out.append(pid)
    out = sorted(set(out))
    if out:
        print(f"[VPS] Découverte pairs : registre public API → {len(out)} peer(s) pour le modèle {MODEL_ID}.")
    return out


def _catalog_from_public_status() -> dict[str, dict]:
    if not _PUBLIC_WORKER_CATALOG:
        return {}
    rows = _fetch_workers_public_status_payload()
    if not rows:
        return {}
    out: dict[str, dict] = {}
    for w in rows:
        pid = str(w.get("peerId") or w.get("peer_id") or "").strip()
        if not pid:
            continue
        out[pid] = w
    if out:
        print(f"[VPS] Catalogue heartbeat : registre public API → {len(out)} entrée(s).")
    return out


def _select_pool_peers(peers: list[str], catalog: dict[str, dict], preference: str) -> tuple[list[str], str, str | None]:
    by_class: dict[str, list[str]] = {"velocity_mlx": [], "velocity_vllm": [], "legacy_pytorch": []}
    for peer in peers:
        by_class.setdefault(_worker_pool_class(catalog.get(peer) or {}), []).append(peer)
    if preference in ("velocity_mlx", "velocity_vllm", "legacy_pytorch"):
        selected = by_class.get(preference, [])
        if len(selected) >= MIN_WORKERS:
            return selected, preference, None
        if preference != "legacy_pytorch" and len(by_class["legacy_pytorch"]) >= MIN_WORKERS:
            return by_class["legacy_pytorch"], "legacy_pytorch", f"{preference}_insufficient_workers"
        return selected, preference, f"{preference}_insufficient_workers"
    if len(by_class["velocity_vllm"]) >= MIN_WORKERS:
        return by_class["velocity_vllm"], "velocity_vllm", None
    if len(by_class["velocity_mlx"]) >= MIN_WORKERS:
        return by_class["velocity_mlx"], "velocity_mlx", None
    return by_class["legacy_pytorch"] or peers, "legacy_pytorch", "velocity_pool_unavailable"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _short(peer_id: str) -> str:
    return (peer_id or "")[:16]


def _relay_timeout_payload(
    peer_id: str,
    dtype: str,
    relay_session_id: str,
    timeout: float,
    elapsed_ms: int,
    payload_size: int,
    routing_path: list | None,
    detail: str = "",
) -> dict[str, Any]:
    hop = _short(peer_id)
    session_label = relay_session_id[:20] if relay_session_id else "n/a"
    route = [_short(str(p)) for p in (routing_path or [])]
    detail_suffix = f" ({detail})" if detail else ""
    return {
        "ok": False,
        "error": (
            f"relay_timeout:{dtype}: target={hop} session={session_label} "
            f"timeout_sec={timeout:g} elapsed_ms={elapsed_ms}{detail_suffix}. "
            "Le hop P2P n'a pas répondu dans le budget; le compute worker peut être trop lent "
            "ou le circuit libp2p a été fermé pendant le forward."
        ),
        "error_code": "relay_timeout",
        "timeout_sec": timeout,
        "relay_ms": elapsed_ms,
        "hidden_bytes": payload_size,
        "target_peer": peer_id,
        "routing_path": route,
        "session_id": relay_session_id,
        "persistent_relay": PERSISTENT_RELAY,
    }

# ── Modèle VPS (singleton) ─────────────────────────────────────────────────────

_model = None
_tokenizer = None
_model_lock = threading.Lock()
_model_config_cache: Optional[dict] = None


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return str(value)


def _token_id(tokenizer: Any, token: str) -> Optional[int]:
    try:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if isinstance(token_id, int) and token_id >= 0:
            return token_id
    except Exception:
        return None
    return None


def _stop_token_ids(tokenizer: Any) -> list[int]:
    ids: set[int] = set()
    for attr in ("eos_token_id", "pad_token_id"):
        token_id = getattr(tokenizer, attr, None)
        if isinstance(token_id, int) and token_id >= 0:
            ids.add(token_id)
    for token in ("<|im_end|>", "<|endoftext|>", "<|end_of_text|>", "<|eot_id|>", "<|end|>"):
        token_id = _token_id(tokenizer, token)
        if token_id is not None:
            ids.add(token_id)
    try:
        for token_id in (getattr(tokenizer, "additional_special_tokens_ids", None) or []):
            if isinstance(token_id, int) and token_id >= 0:
                ids.add(token_id)
    except Exception:
        pass
    return sorted(ids)


def _clean_response_text(text: str) -> str:
    """Retire les marqueurs chat Qwen / contrôle sans effacer la réponse utile."""
    if not text:
        return ""
    cleaned = text
    for prefix in (
        "<|im_start|>assistant\n",
        "<|im_start|>assistant",
        "<|im_start|>user\n",
        "<|im_start|>user",
        "<|im_start|>",
        "<|im_end|>\n",
        "<|im_end|>",
    ):
        if prefix in cleaned:
            cleaned = cleaned.replace(prefix, "")
    # Ne pas utiliser split(...)[0] seul sur <|eot_id|> : le modèle peut l'émettre en tête,
    # ce qui vidait toute la sortie (d'où « 32 jetons » mais texte vide côté VPS).
    markers = (
        "<|im_end|>",
        "<|endoftext|>",
        "<|end_of_text|>",
        "<|eot_id|>",
        "</s>",
    )
    for marker in markers:
        if marker not in cleaned:
            continue
        before, _sep, after = cleaned.partition(marker)
        if before.strip():
            cleaned = before
        elif after.strip():
            cleaned = after
        else:
            cleaned = before + after
    if "</think>" in cleaned:
        cleaned = cleaned.split("</think>", 1)[-1]
    return cleaned.strip()


def _decode_generated_token_ids(tokenizer: Any, ids: list[int]) -> str:
    """Décode les jetons générés (Qwen / SentencePiece) avec plusieurs stratégies HF."""
    if not ids:
        return ""

    def _one(skip_special: bool, clean_spaces: bool | None) -> str:
        kwargs: dict[str, Any] = {"skip_special_tokens": skip_special}
        if clean_spaces is not None:
            kwargs["clean_up_tokenization_spaces"] = clean_spaces
        try:
            raw = tokenizer.decode(ids, **kwargs)
        except TypeError:
            raw = tokenizer.decode(ids, skip_special_tokens=skip_special)
        return _clean_response_text(raw)

    for skip_special in (True, False):
        for clean_spaces in (True, False, None):
            out = _one(skip_special, clean_spaces).strip()
            if out:
                return _one(skip_special, clean_spaces)
    try:
        toks = tokenizer.convert_ids_to_tokens(ids)
        if hasattr(tokenizer, "convert_tokens_to_string"):
            raw2 = tokenizer.convert_tokens_to_string(toks)
        else:
            raw2 = "".join(str(t) for t in toks if t is not None)
        out2 = _clean_response_text(raw2).strip()
        if out2:
            return out2
    except Exception:
        pass
    return ""


def _detect_repetition_loop(text: str) -> bool:
    if not REPETITION_GUARD:
        return False
    words = text.lower().split()
    if len(words) < 24:
        return False
    for size in (3, 4, 5, 6):
        tail = words[-size:]
        if not tail:
            continue
        repeats = 0
        for i in range(2, 6):
            start = len(words) - size * i
            end = start + size
            if start < 0:
                break
            if words[start:end] == tail:
                repeats += 1
        if repeats >= 3:
            return True
    return False


def _build_model_config(cfg: Any) -> dict:
    text_cfg = getattr(cfg, "text_config", None) or cfg
    model_type = getattr(text_cfg, "model_type", None) or getattr(cfg, "model_type", "gpt2")
    vocab_size = getattr(text_cfg, "vocab_size", None) or getattr(cfg, "vocab_size", None)
    if vocab_size is None:
        raise RuntimeError("vocab_size absent de la config modèle")
    rope_parameters = _jsonable(getattr(text_cfg, "rope_parameters", None))
    rope_theta = getattr(text_cfg, "rope_theta", None)
    if rope_theta is None and isinstance(rope_parameters, dict):
        rope_theta = rope_parameters.get("rope_theta")
    if rope_theta is None:
        rope_theta = 10000.0
    return {
        "model_type": model_type,
        # GPT-2 fields
        "hidden_size": getattr(text_cfg, "hidden_size", None) or getattr(text_cfg, "n_embd", 768),
        "num_hidden_layers_total": getattr(text_cfg, "num_hidden_layers", None) or getattr(text_cfg, "n_layer", 12),
        "num_attention_heads": getattr(text_cfg, "num_attention_heads", None) or getattr(text_cfg, "n_head", 12),
        "num_key_value_heads": getattr(text_cfg, "num_key_value_heads", None) or getattr(text_cfg, "n_head", 12),
        "intermediate_size": getattr(text_cfg, "intermediate_size", None) or getattr(text_cfg, "n_inner", None) or 3072,
        "vocab_size": vocab_size,
        # GPT-2 specific
        "n_positions": getattr(text_cfg, "n_positions", 1024),
        "n_embd": getattr(text_cfg, "n_embd", 768),
        "n_layer": getattr(text_cfg, "n_layer", 12),
        "n_head": getattr(text_cfg, "n_head", 12),
        "layer_norm_epsilon": getattr(text_cfg, "layer_norm_epsilon", 1e-5),
        "embd_pdrop": getattr(text_cfg, "embd_pdrop", 0.1),
        # Qwen/LLaMA-style
        "rms_norm_eps": getattr(text_cfg, "rms_norm_eps", 1e-6),
        "rope_theta": rope_theta,
        "max_position_embeddings": getattr(text_cfg, "max_position_embeddings", None) or getattr(text_cfg, "n_positions", 1024),
        "layer_types": _jsonable(getattr(text_cfg, "layer_types", None)),
        "rope_parameters": rope_parameters,
    }


def _load_safetensor_weight_map(snapshot_dir: str) -> dict[str, str]:
    index_files = [
        os.path.join(snapshot_dir, "model.safetensors.index.json"),
        os.path.join(snapshot_dir, "pytorch_model.bin.index.json"),
    ]
    for index_file in index_files:
        if os.path.exists(index_file):
            with open(index_file, "r") as f:
                index = json.load(f)
            weight_map = index.get("weight_map") or {}
            if weight_map:
                return {str(k): str(v) for k, v in weight_map.items()}

    from safetensors import safe_open

    weight_map: dict[str, str] = {}
    for root, _dirs, files in os.walk(snapshot_dir):
        for file_name in files:
            if not file_name.endswith(".safetensors"):
                continue
            full_path = os.path.join(root, file_name)
            rel_path = os.path.relpath(full_path, snapshot_dir)
            with safe_open(full_path, framework="np", device="cpu") as handle:
                for key in handle.keys():
                    weight_map[str(key)] = rel_path
    return weight_map


def _ensure_model():
    global _model, _tokenizer, _model_config_cache
    with _model_lock:
        if _model is not None:
            return _model, _tokenizer
        try:
            from huggingface_hub import snapshot_download
            from transformers import AutoConfig, AutoTokenizer
            print(f"[VPS] Chargement léger {MODEL_ID} : tokenizer + config + poids disque…")
            t0 = time.perf_counter()
            _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
            cfg = AutoConfig.from_pretrained(MODEL_ID, trust_remote_code=True)
            snapshot_dir = snapshot_download(
                MODEL_ID,
                allow_patterns=[
                    "*.json",
                    "*.safetensors",
                    "tokenizer*",
                    "*.model",
                    "*.tiktoken",
                    "merges.txt",
                    "vocab.*",
                    "special_tokens_map.json",
                    "generation_config.json",
                ],
            )
            weight_map = _load_safetensor_weight_map(snapshot_dir)
            if not weight_map:
                raise RuntimeError("aucun poids safetensors trouvé dans le snapshot HF")
            _model_config_cache = _build_model_config(cfg)
            _model = {
                "snapshot_dir": snapshot_dir,
                "weight_map": weight_map,
                "config": _model_config_cache,
            }
            elapsed = int((time.perf_counter() - t0) * 1000)
            print(f"[VPS] Manifeste modèle prêt : {len(weight_map)} tenseurs sur disque, {elapsed}ms")
        except Exception as e:
            print(f"[VPS] Impossible de charger {MODEL_ID} : {e}")
            _model = None
            _tokenizer = None
    return _model, _tokenizer


# ── Découverte des workers ─────────────────────────────────────────────────────

def _discover_live_peers() -> list[str]:
    # 0. Variable d'environnement explicite (priorité maximale)
    explicit = os.environ.get("VRYX_DIST_PEER_IDS", "").strip()
    if explicit:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    # 1. API Express interne
    for port in (48953, 4000):
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/internal/live-peers",
                method="GET",
                headers={"X-Internal-Token": "vryx-internal-localhost"},
            )
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                j = json.loads(resp.read().decode("utf-8"))
            if j.get("ok") and isinstance(j.get("peers"), list):
                peers = [p for p in j["peers"] if isinstance(p, str) and p.strip()]
                if peers:
                    return peers
        except Exception:
            continue
    # 2. Relay Rust /api/tp-peers (pairs déjà dans le swarm initiateur ; peut rester vide si les dials WAN sont retardés).
    try:
        req = urllib.request.Request(f"{RELAY_URL}/api/tp-peers", method="GET")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        if j.get("ok") and isinstance(j.get("peers"), list):
            peers = [p for p in j["peers"] if isinstance(p, str) and p.strip()]
            if peers:
                return peers
    except Exception:
        pass
    # 3. Heartbeat HTTPS : les workers sont visibles avant la connexion P2P active ; le daemon ouvre souvent le circuit au 1ᵉʳ relay.
    return _peers_public_registry_live()


def _fetch_worker_catalog() -> dict[str, dict]:
    """Infos heartbeat utiles au placement pondéré (VRAM, GPU, modèle)."""
    for url in ("http://127.0.0.1:48953/api/workers/status", "http://127.0.0.1:4000/api/workers/status"):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=5.0) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            workers = body.get("workers") if isinstance(body, dict) else []
            if isinstance(workers, list):
                out: dict[str, dict] = {}
                for w in workers:
                    if not isinstance(w, dict):
                        continue
                    pid = str(w.get("peerId") or w.get("peer_id") or "")
                    if not pid:
                        continue
                    out[pid] = w
                if out:
                    return out
        except Exception:
            continue
    return _catalog_from_public_status()


def _gpu_compute_hint(worker: dict) -> float:
    name = str(worker.get("gpuName") or worker.get("gpu_name") or "").lower()
    # Heuristique locale : on n'invente pas une base matérielle, on pondère juste les cartes connues.
    if "4090" in name:
        return 1.9
    if "4080" in name or "3090" in name:
        return 1.55
    if "4070" in name or "3080" in name:
        return 1.3
    if "3060" in name or "3070" in name:
        return 1.0
    if "mps" in name or "apple" in name:
        return 0.75
    return 1.0


def _implicit_vram_mb_for_weight(worker: dict[str, Any]) -> float:
    """
    Si le heartbeat n'envoie pas gpuVramMb (souvent MPS / Apple), on estime selon le modèle
    annoncé pour ne pas sur-pondérer un Mac 0.5B comme une machine 8 Go discrète.
    """
    raw = float(worker.get("gpuVramMb") or worker.get("gpu_vram_mb") or 0)
    if raw > 0:
        return raw
    mid = str(worker.get("model") or worker.get("model_id") or MODEL_ID).lower()
    if any(x in mid for x in ("0.5b", "0.6b", "1b", "1.5b", "2b", "3b")):
        return 6144.0
    if any(x in mid for x in ("9b", "8b", "7b")):
        return 16384.0
    if any(x in mid for x in ("32b", "34b")):
        return 49152.0
    if any(x in mid for x in ("72b", "70b", "65b")):
        return 98304.0
    return 8192.0


def _worker_weight(peer_id: str, catalog: dict[str, dict]) -> float:
    w = catalog.get(peer_id) or {}
    vram_mb = _implicit_vram_mb_for_weight(w)
    return max(1.0, (vram_mb / 1024.0) * _gpu_compute_hint(w))


def _weighted_counts(total_layers: int, workers: list[str], catalog: dict[str, dict]) -> list[int]:
    if not workers:
        return []
    weights = [_worker_weight(p, catalog) for p in workers]
    total_weight = sum(weights) or float(len(workers))
    raw = [max(1, int(round(total_layers * (w / total_weight)))) for w in weights]
    while sum(raw) > total_layers:
        idx = max(range(len(raw)), key=lambda i: raw[i])
        if raw[idx] > 1:
            raw[idx] -= 1
        else:
            break
    while sum(raw) < total_layers:
        idx = max(range(len(raw)), key=lambda i: weights[i])
        raw[idx] += 1
    return raw


# ── Extraction des poids par tranche ──────────────────────────────────────────

def _extract_worker_weights(model, layer_start: int, layer_end: int,
                             has_embedding: bool, has_lm_head: bool) -> dict[str, np.ndarray]:
    """Extrait les poids d'une tranche de couches en numpy float16 (GPT-2 ou Qwen2)."""
    weights: dict[str, np.ndarray] = {}
    cfg = model.config
    model_type = getattr(cfg, "model_type", "gpt2")

    if model_type == "gpt2":
        if has_embedding:
            weights["wte.weight"] = model.transformer.wte.weight.detach().half().numpy()
            weights["wpe.weight"] = model.transformer.wpe.weight.detach().half().numpy()
        for global_idx in range(layer_start, layer_end + 1):
            local_idx = global_idx - layer_start
            for name, param in model.transformer.h[global_idx].named_parameters():
                weights[f"h.{local_idx}.{name}"] = param.detach().half().numpy()
        if has_lm_head:
            weights["ln_f.weight"] = model.transformer.ln_f.weight.detach().half().numpy()
            weights["ln_f.bias"] = model.transformer.ln_f.bias.detach().half().numpy()
            # GPT-2 lm_head partage les poids avec wte
            weights["lm_head.weight"] = model.lm_head.weight.detach().half().numpy()
    else:
        # Qwen2 / Qwen3 / LLaMA-style
        if has_embedding:
            weights["embed_tokens.weight"] = model.model.embed_tokens.weight.detach().half().numpy()
        for global_idx in range(layer_start, layer_end + 1):
            local_idx = global_idx - layer_start
            for name, param in model.model.layers[global_idx].named_parameters():
                weights[f"layers.{local_idx}.{name}"] = param.detach().half().numpy()
        if has_lm_head:
            weights["norm.weight"] = model.model.norm.weight.detach().half().numpy()
            weights["lm_head.weight"] = model.lm_head.weight.detach().half().numpy()

    total_mb = sum(a.nbytes for a in weights.values()) / 1e6
    print(f"[VPS] Tranche layers {layer_start}-{layer_end} ({model_type}) : {len(weights)} params, {total_mb:.1f} MB")
    return weights


# ── Envoi des poids via P2P ────────────────────────────────────────────────────

def _relay_try_http_keepalive(
    url: str,
    body: bytes,
    timeout: float,
    t0: float,
    serialization_ms: int,
    payload_len: int,
    peer_id: str,
    relay_session_id: str,
    routing_path: list | None,
) -> dict | None:
    try:
        pu = urlparse(url)
    except Exception:
        return None
    if pu.scheme != "http" or not pu.hostname:
        return None
    host = pu.hostname
    port = int(pu.port or 80)
    path = pu.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    hdrs = {
        "Content-Type": "application/json",
        "Connection": "keep-alive",
    }
    try:
        key = (host, port)
        if getattr(RELAY_TLS, "http_host_port", None) != key or getattr(RELAY_TLS, "http_conn", None) is None:
            try:
                old = getattr(RELAY_TLS, "http_conn", None)
                if old is not None:
                    old.close()
            except Exception:
                pass
            RELAY_TLS.http_conn = http.client.HTTPConnection(host, port, timeout=min(float(timeout), 600.0))
            RELAY_TLS.http_host_port = key
        conn = RELAY_TLS.http_conn
        assert conn is not None
        conn.request("POST", path, body=body, headers=hdrs)
        resp = conn.getresponse()
        status = int(resp.status)
        raw = resp.read()
        if status != 200:
            try:
                conn.close()
            except Exception:
                pass
            RELAY_TLS.http_conn = None
            return None
        result = json.loads(raw.decode("utf-8"))
        if isinstance(result, dict):
            result.setdefault("relay_ms", int((time.perf_counter() - t0) * 1000))
            result.setdefault("serialization_ms", serialization_ms)
            result.setdefault("hidden_bytes", payload_len)
            result.setdefault("persistent_relay", PERSISTENT_RELAY)
            result.setdefault("connection_reuse", True)
        return result if isinstance(result, dict) else None
    except Exception:
        try:
            c = getattr(RELAY_TLS, "http_conn", None)
            if c is not None:
                c.close()
        except Exception:
            pass
        RELAY_TLS.http_conn = None
        return None


def _relay_raw(peer_id: str, dtype: str, payload: bytes, timeout: float = TIMEOUT,
               routing_path: list | None = None) -> dict:
    url = f"{RELAY_URL}/api/p2p/relay"
    t0 = time.perf_counter()
    serialization_start = time.perf_counter()
    relay_session_id = ""
    try:
        payload_obj = json.loads(payload.decode("utf-8", errors="replace")) if payload else {}
        if isinstance(payload_obj, dict):
            relay_session_id = str(payload_obj.get("session_id") or "")
    except Exception:
        relay_session_id = ""
    body = json.dumps({
        "target_peer": peer_id,
        "dtype": dtype,
        "data_b64": base64.standard_b64encode(payload).decode("ascii"),
        "routing_path": routing_path or [],
        "session_id": relay_session_id,
        "persistent_relay": PERSISTENT_RELAY,
    }).encode("utf-8")
    serialization_ms = int((time.perf_counter() - serialization_start) * 1000)
    ka = _relay_try_http_keepalive(
        url, body, timeout, t0, serialization_ms, len(payload), peer_id, relay_session_id, routing_path,
    )
    if ka is not None:
        return ka
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if isinstance(result, dict):
                result.setdefault("relay_ms", int((time.perf_counter() - t0) * 1000))
                result.setdefault("serialization_ms", serialization_ms)
                result.setdefault("hidden_bytes", len(payload))
                result.setdefault("persistent_relay", PERSISTENT_RELAY)
                result.setdefault("connection_reuse", bool(result.get("connection_reuse", PERSISTENT_RELAY)))
            return result
    except urllib.error.HTTPError as e:
        body_err = ""
        try:
            body_err = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        lowered = body_err.lower()
        if e.code in (502, 504) and ("timeout" in lowered or "timed out" in lowered or "délai" in lowered):
            return _relay_timeout_payload(
                peer_id,
                dtype,
                relay_session_id,
                timeout,
                int((time.perf_counter() - t0) * 1000),
                len(payload),
                routing_path,
                detail=f"http_{e.code}:{body_err[:160]}",
            )
        return {
            "ok": False,
            "error": f"HTTP {e.code}: {body_err}",
            "relay_ms": int((time.perf_counter() - t0) * 1000),
            "serialization_ms": serialization_ms,
            "hidden_bytes": len(payload),
            "persistent_relay": PERSISTENT_RELAY,
        }
    except (TimeoutError, socket.timeout) as ex:
        return _relay_timeout_payload(
            peer_id,
            dtype,
            relay_session_id,
            timeout,
            int((time.perf_counter() - t0) * 1000),
            len(payload),
            routing_path,
            detail=str(ex) or "socket_timeout",
        )
    except Exception as ex:
        err_text = str(ex)
        if "timeout" in err_text.lower() or "timed out" in err_text.lower():
            return _relay_timeout_payload(
                peer_id,
                dtype,
                relay_session_id,
                timeout,
                int((time.perf_counter() - t0) * 1000),
                len(payload),
                routing_path,
                detail=err_text[:160],
            )
        return {
            "ok": False,
            "error": err_text,
            "relay_ms": int((time.perf_counter() - t0) * 1000),
            "serialization_ms": serialization_ms,
            "hidden_bytes": len(payload),
            "persistent_relay": PERSISTENT_RELAY,
        }


_batch_queues: dict[str, BatchQueue] = {}
_batch_threads: dict[str, threading.Thread] = {}
_batch_lock = threading.Lock()


def _decode_pipeline_response(result: dict[str, Any]) -> dict[str, Any]:
    relay_data_b64 = result.get("data_b64", "")
    if relay_data_b64:
        raw = base64.b64decode(relay_data_b64)
        return json.loads(raw.decode("utf-8", errors="replace"))
    inner = result.get("data")
    if isinstance(inner, dict) and inner.get("data_b64"):
        raw = base64.b64decode(inner["data_b64"])
        return json.loads(raw.decode("utf-8", errors="replace"))
    return {}


def _relay_result_from_response(response: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": response.get("ok", True) is not False,
        "data_b64": base64.b64encode(json.dumps(response, ensure_ascii=False).encode("utf-8")).decode("ascii"),
    }


def _batch_key(peer_id: str, dtype: str, routing_path: list[str], shard_session_id: str) -> str:
    return "|".join([peer_id, dtype, shard_session_id, *routing_path])


def _batch_payload_shape(payload: dict[str, Any]) -> tuple[Any, ...]:
    if isinstance(payload.get("token_ids"), list):
        return ("tokens", len(payload.get("token_ids") or []), bool(payload.get("use_kv_cache")), int(payload.get("step") or 0) > 0)
    if isinstance(payload.get("hidden_shape"), list):
        return ("hidden", tuple(payload.get("hidden_shape") or []), bool(payload.get("use_kv_cache")), int(payload.get("step") or 0) > 0)
    return ("unknown",)


def _run_batch_worker(key: str, peer_id: str, dtype: str, routing_path: list[str], shard_session_id: str) -> None:
    queue_ref = _batch_queues[key]
    while True:
        try:
            items, trace = queue_ref.drain()
        except Exception:
            with _batch_lock:
                if queue_ref.empty():
                    _batch_threads.pop(key, None)
                    return
            continue

        t0 = time.perf_counter()
        try:
            first_payload = items[0].payload
            shape_key = _batch_payload_shape(first_payload)
            compatible = len(items) > 1 and all(_batch_payload_shape(item.payload) == shape_key for item in items)
            if compatible:
                batch_payload = {
                    "session_id": shard_session_id,
                    "batch_items": [
                        {
                            "request_id": str(item.payload.get("request_id") or item.session_id),
                            "session_id": str(item.payload.get("session_id") or shard_session_id),
                            "payload": item.payload,
                        }
                        for item in items
                    ],
                    "batching": {
                        **trace,
                        "enabled": True,
                        "mode": "continuous_batching",
                    },
                }
                result = _relay_raw(
                    peer_id,
                    dtype,
                    json.dumps(batch_payload, ensure_ascii=False).encode("utf-8"),
                    timeout=PIPELINE_STEP_TIMEOUT,
                    routing_path=routing_path,
                )
                response = _decode_pipeline_response(result) if result.get("ok", True) else {}
                response_items = response.get("batch_items") if isinstance(response, dict) else None
                if result.get("ok", True) and isinstance(response_items, list):
                    by_request = {
                        str(item.get("request_id") or item.get("session_id") or ""): item
                        for item in response_items
                        if isinstance(item, dict)
                    }
                    for item in items:
                        request_id = str(item.payload.get("request_id") or item.session_id)
                        item_response = by_request.get(request_id)
                        if item_response is None:
                            item_response = {"ok": False, "error": "batch response missing item", "request_id": request_id}
                        item_response.setdefault("batching", {})
                        item_response["batching"].update({
                            **trace,
                            "enabled": True,
                            "decode_batch_ms": int((time.perf_counter() - t0) * 1000),
                            "mode": "continuous_batching",
                        })
                        if item.future is not None:
                            item.future.set_result(_relay_result_from_response(item_response))
                    continue

            # Fallback single-session : payload inchangé, même Daisy Chain.
            for item in items:
                result = _relay_raw(
                    peer_id,
                    dtype,
                    json.dumps(item.payload, ensure_ascii=False).encode("utf-8"),
                    timeout=PIPELINE_STEP_TIMEOUT,
                    routing_path=routing_path,
                )
                if item.future is not None:
                    item.future.set_result(result)
        except BaseException as exc:
            for item in items:
                if item.future is not None:
                    item.future.set_error(exc)


def _relay_pipeline_step(
    peer_id: str,
    dtype: str,
    payload: dict[str, Any],
    routing_path: list[str],
    batch_enabled: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if routing_path and PIPELINE_CHAIN_MODE in ("vps_sequential", "initiator_sequential", "sequential"):
        peers = [peer_id] + list(routing_path)
        current_payload = payload
        hop_traces: list[dict[str, Any]] = []
        t_chain = time.perf_counter()
        result: dict[str, Any] = {"ok": False, "error": "pipeline chain empty"}
        for hop_index, hop_peer in enumerate(peers):
            t_hop = time.perf_counter()
            result = _relay_raw(
                hop_peer,
                dtype,
                json.dumps(current_payload, ensure_ascii=False).encode("utf-8"),
                timeout=PIPELINE_STEP_TIMEOUT,
                routing_path=[],
            )
            hop_traces.append({
                "peer": hop_peer,
                "rank": hop_index,
                "relay_ms": result.get("relay_ms"),
                "serialization_ms": result.get("serialization_ms"),
                "hidden_bytes": result.get("hidden_bytes"),
                "ms": int((time.perf_counter() - t_hop) * 1000),
                "ok": result.get("ok", True) is not False,
                "error": result.get("error"),
            })
            if not result.get("ok", True):
                break
            response = _decode_pipeline_response(result)
            if not isinstance(response, dict):
                result = {"ok": False, "error": f"hop {hop_index} response invalid"}
                hop_traces[-1]["ok"] = False
                hop_traces[-1]["error"] = result["error"]
                break
            if hop_index < len(peers) - 1:
                if response.get("ok") is False:
                    result = {"ok": False, "error": response.get("error") or f"hop {hop_index} refused"}
                    hop_traces[-1]["ok"] = False
                    hop_traces[-1]["error"] = result["error"]
                    break
                current_payload = response
        return result, {
            **batching_trace(False, 1),
            "decode_batch_ms": int((time.perf_counter() - t_chain) * 1000),
            "chain_mode": PIPELINE_CHAIN_MODE,
            "hop_traces": hop_traces,
            "worker_to_worker_bypass": True,
        }

    if not batch_enabled:
        t0 = time.perf_counter()
        result = _relay_raw(
            peer_id,
            dtype,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            timeout=PIPELINE_STEP_TIMEOUT,
            routing_path=routing_path,
        )
        return result, {**batching_trace(False, 1), "decode_batch_ms": int((time.perf_counter() - t0) * 1000)}

    shard_session_id = str(payload.get("session_id") or "")
    key = _batch_key(peer_id, dtype, routing_path, shard_session_id)
    with _batch_lock:
        queue_ref = _batch_queues.setdefault(key, BatchQueue(BATCH_MAX_SIZE, BATCH_WINDOW_MS))
        future = queue_ref.submit(str(payload.get("request_id") or shard_session_id), payload)
        if key not in _batch_threads or not _batch_threads[key].is_alive():
            thread = threading.Thread(
                target=_run_batch_worker,
                args=(key, peer_id, dtype, list(routing_path), shard_session_id),
                daemon=True,
            )
            _batch_threads[key] = thread
            thread.start()

    t0 = time.perf_counter()
    try:
        result = future.result(timeout=PIPELINE_STEP_TIMEOUT + (BATCH_WINDOW_MS / 1000.0) + 5.0)
    except Exception as exc:
        return {
            "ok": False,
            "error": f"batch_scheduler:{type(exc).__name__}:{exc}",
        }, {
            **batching_trace(True, 1),
            "enabled": True,
            "decode_batch_ms": int((time.perf_counter() - t0) * 1000),
            "fallback_reason": "scheduler_error",
        }
    decode_batch_ms = int((time.perf_counter() - t0) * 1000)
    try:
        response = _decode_pipeline_response(result)
        trace = response.get("batching") if isinstance(response.get("batching"), dict) else {}
    except Exception:
        trace = {}
    return result, {
        **batching_trace(True, int(trace.get("batch_size") or 1)),
        **trace,
        "enabled": True,
        "decode_batch_ms": int(trace.get("decode_batch_ms") or decode_batch_ms),
    }


def _purge_old_shards(keep_session: str = "") -> None:
    """Supprime les anciens shards pour libérer /tmp."""
    if KEEP_POOL_SHARDS:
        return
    base_dir = SHARD_BASE_DIR
    if not os.path.isdir(base_dir):
        return
    for entry in os.listdir(base_dir):
        if entry == keep_session:
            continue
        full = os.path.join(base_dir, entry)
        if os.path.isdir(full):
            try:
                import shutil
                shutil.rmtree(full)
            except Exception:
                pass


def _save_shard_to_disk(
    session_id: str,
    peer_idx: int,
    layer_start: int,
    layer_end: int,
    has_embedding: bool,
    has_lm_head: bool,
    weights: dict[str, np.ndarray],
    model_config: dict,
) -> str:
    """
    Sauvegarde un shard de poids au format binaire compact :
      - worker-N.json : manifeste (config + index des paramètres avec offsets)
      - worker-N.bin  : tous les tenseurs concaténés en raw bytes float16

    Beaucoup plus compact que JSON+base64 (économise ~33%).
    """
    shard_dir = os.path.join(SHARD_BASE_DIR, session_id)
    os.makedirs(shard_dir, exist_ok=True)

    bin_filename = f"worker-{peer_idx}.bin"
    json_filename = f"worker-{peer_idx}.json"
    bin_filepath = os.path.join(shard_dir, bin_filename)
    json_filepath = os.path.join(shard_dir, json_filename)

    # Concaténation des tenseurs en un seul .bin avec index
    index = []
    offset = 0
    with open(bin_filepath, "wb") as f:
        for name, arr in weights.items():
            data = arr.tobytes()
            f.write(data)
            index.append({
                "name": name,
                "shape": list(arr.shape),
                "dtype": str(arr.dtype),
                "offset": offset,
                "nbytes": len(data),
            })
            offset += len(data)

    # Manifeste JSON pour le worker (URL joignables depuis les workers distants ; pas forcément localhost)
    api_base = _worker_shard_download_base_url()
    bin_url = f"{api_base}/api/internal/shard-serve/{session_id}/{bin_filename}"
    manifest = {
        "session_id": session_id,
        "layer_start": layer_start,
        "layer_end": layer_end,
        "model_config": model_config,
        "has_embedding": has_embedding,
        "has_lm_head": has_lm_head,
        "ttl_sec": SHARD_TTL,
        "binary_url": bin_url,
        "binary_total_bytes": offset,
        "weights_index": index,
    }
    with open(json_filepath, "w") as f:
        json.dump(manifest, f)

    bin_mb = os.path.getsize(bin_filepath) / 1e6
    json_kb = os.path.getsize(json_filepath) / 1e3
    print(f"[VPS] Shard worker-{peer_idx} : {bin_mb:.1f} MB binaire + {json_kb:.1f} KB manifeste ({len(index)} params)")
    return f"{api_base}/api/internal/shard-serve/{session_id}/{json_filename}"


def _selected_tensor_names(
    model_config: dict,
    weight_map: dict[str, str],
    layer_start: int,
    layer_end: int,
    has_embedding: bool,
    has_lm_head: bool,
) -> list[tuple[str, str]]:
    model_type = str(model_config.get("model_type") or "gpt2")
    selected: list[tuple[str, str]] = []

    if model_type == "gpt2":
        if has_embedding:
            selected.extend([
                ("transformer.wte.weight", "wte.weight"),
                ("transformer.wpe.weight", "wpe.weight"),
            ])
        for global_idx in range(layer_start, layer_end + 1):
            local_idx = global_idx - layer_start
            prefix = f"transformer.h.{global_idx}."
            for src in sorted(k for k in weight_map if k.startswith(prefix)):
                selected.append((src, f"h.{local_idx}.{src[len(prefix):]}"))
        if has_lm_head:
            selected.extend([
                ("transformer.ln_f.weight", "ln_f.weight"),
                ("transformer.ln_f.bias", "ln_f.bias"),
                ("lm_head.weight", "lm_head.weight"),
            ])
    else:
        if "model.embed_tokens.weight" in weight_map:
            base_prefix = "model"
        elif "model.language_model.embed_tokens.weight" in weight_map:
            base_prefix = "model.language_model"
        else:
            base_prefix = "model"
        if has_embedding:
            selected.append((f"{base_prefix}.embed_tokens.weight", "embed_tokens.weight"))
        for global_idx in range(layer_start, layer_end + 1):
            local_idx = global_idx - layer_start
            prefix = f"{base_prefix}.layers.{global_idx}."
            for src in sorted(k for k in weight_map if k.startswith(prefix)):
                selected.append((src, f"layers.{local_idx}.{src[len(prefix):]}"))
        if has_lm_head:
            selected.append((f"{base_prefix}.norm.weight", "norm.weight"))
            if "lm_head.weight" in weight_map:
                selected.append(("lm_head.weight", "lm_head.weight"))
            elif f"{base_prefix}.embed_tokens.weight" in weight_map:
                selected.append((f"{base_prefix}.embed_tokens.weight", "lm_head.weight"))

    missing = [src for src, _dst in selected if src not in weight_map]
    if missing:
        raise RuntimeError(f"poids absents du snapshot : {missing[:5]}")
    return selected


def _save_shard_to_disk_from_safetensors(
    session_id: str,
    peer_idx: Any,
    layer_start: int,
    layer_end: int,
    has_embedding: bool,
    has_lm_head: bool,
    model_manifest: dict,
    model_config: dict,
) -> str:
    """
    Écrit le shard depuis les fichiers safetensors HF sans instancier le modèle complet.
    Le VPS lit un tenseur à la fois depuis le SSD et ne garde pas le LLM actif en RAM.
    """
    from safetensors import safe_open
    import torch

    shard_dir = os.path.join(SHARD_BASE_DIR, session_id)
    os.makedirs(shard_dir, exist_ok=True)

    bin_filename = f"worker-{peer_idx}.bin"
    json_filename = f"worker-{peer_idx}.json"
    bin_filepath = os.path.join(shard_dir, bin_filename)
    json_filepath = os.path.join(shard_dir, json_filename)

    snapshot_dir = str(model_manifest["snapshot_dir"])
    weight_map = dict(model_manifest["weight_map"])
    selected = _selected_tensor_names(model_config, weight_map, layer_start, layer_end, has_embedding, has_lm_head)

    index = []
    offset = 0
    with open(bin_filepath, "wb") as out:
        for src_name, dst_name in selected:
            tensor_file = os.path.join(snapshot_dir, weight_map[src_name])
            with safe_open(tensor_file, framework="pt", device="cpu") as handle:
                tensor = handle.get_tensor(src_name)
            if tensor.dtype not in (torch.float16, torch.float32):
                tensor = tensor.to(torch.float16)
            elif tensor.dtype == torch.float32:
                tensor = tensor.to(torch.float16)
            arr = tensor.contiguous().cpu().numpy()
            data = arr.tobytes()
            out.write(data)
            index.append({
                "name": dst_name,
                "shape": list(arr.shape),
                "dtype": str(arr.dtype),
                "offset": offset,
                "nbytes": len(data),
            })
            offset += len(data)
            del tensor, arr, data

    api_base = _worker_shard_download_base_url()
    bin_url = f"{api_base}/api/internal/shard-serve/{session_id}/{bin_filename}"
    manifest = {
        "session_id": session_id,
        "layer_start": layer_start,
        "layer_end": layer_end,
        "model_config": model_config,
        "has_embedding": has_embedding,
        "has_lm_head": has_lm_head,
        "ttl_sec": SHARD_TTL,
        "binary_url": bin_url,
        "binary_total_bytes": offset,
        "weights_index": index,
    }
    with open(json_filepath, "w") as f:
        json.dump(manifest, f)

    bin_mb = os.path.getsize(bin_filepath) / 1e6
    json_kb = os.path.getsize(json_filepath) / 1e3
    print(
        f"[VPS] Shard worker-{peer_idx} disque : {bin_mb:.1f} MB binaire + "
        f"{json_kb:.1f} KB manifeste ({len(index)} params)"
    )
    return f"{api_base}/api/internal/shard-serve/{session_id}/{json_filename}"


def _delete_temp_shard_files(session_id: str, peer_idx: Any) -> None:
    shard_dir = os.path.join(SHARD_BASE_DIR, session_id)
    for suffix in ("bin", "json"):
        path = os.path.join(shard_dir, f"worker-{peer_idx}.{suffix}")
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as exc:
            print(f"[VPS] Impossible de supprimer {path}: {exc}")


def _push_weights_to_worker(
    peer_id: str,
    session_id: str,
    layer_start: int,
    layer_end: int,
    has_embedding: bool,
    has_lm_head: bool,
    weights: dict[str, np.ndarray],
    model_config: dict,
) -> bool:
    """
    Envoie shard.init + shard.load au worker.
    Stratégie : relay P2P pour init, séquentiel (pas de threads) pour load.
    """
    # Init via relay
    init_payload = json.dumps({
        "session_id": session_id,
        "layer_start": layer_start,
        "layer_end": layer_end,
        "model_config": model_config,
        "has_embedding": has_embedding,
        "has_lm_head": has_lm_head,
        "ttl_sec": SHARD_TTL,
    }).encode()
    r = _relay_raw(peer_id, "vryx.shard.init", init_payload, timeout=SHARD_INIT_TIMEOUT)
    if not r.get("ok", True):
        print(f"[VPS] shard.init failed peer={peer_id[:16]} : {r.get('error')}")
        return False

    # Load séquentiel — chaque paramètre l'un après l'autre (évite la saturation relay)
    n_ok = 0
    n_fail = 0
    for param_name, arr in weights.items():
        load_payload = json.dumps({
            "session_id": session_id,
            "param_name": param_name,
            "shape": list(arr.shape),
            "dtype": str(arr.dtype),
            "chunk_index": 0,
            "chunk_total": 1,
            "data_b64": base64.b64encode(arr.tobytes()).decode(),
        }).encode()
        # Plusieurs tentatives si le relay échoue
        for attempt in range(3):
            r = _relay_raw(peer_id, "vryx.shard.load", load_payload, timeout=SHARD_LOAD_TIMEOUT)
            if r.get("ok", True) and "error" not in r.get("error", ""):
                # Check gRPC-level ok
                resp_data = r.get("data") or {}
                if isinstance(resp_data, dict) and resp_data.get("ok") is False:
                    if attempt < 2:
                        time.sleep(0.5)
                        continue
                n_ok += 1
                break
            if attempt < 2:
                time.sleep(1.0)
        else:
            n_fail += 1
            print(f"[VPS] shard.load échec (3 tentatives) param={param_name}")

    print(f"[VPS] Poids envoyés : {n_ok} OK / {n_fail} échec pour peer={peer_id[:16]}")

    # Build
    build_payload = json.dumps({"session_id": session_id}).encode()
    for attempt in range(3):
        r = _relay_raw(peer_id, "vryx.shard.build", build_payload, timeout=SHARD_BUILD_TIMEOUT)
        if r.get("ok", True):
            break
        if attempt < 2:
            time.sleep(1.0)
    else:
        print(f"[VPS] shard.build failed peer={peer_id[:16]} : {r.get('error')}")
        return False

    print(f"[VPS] Worker {peer_id[:16]}… prêt (layers {layer_start}-{layer_end}, {n_ok}/{n_ok+n_fail} poids)")
    return True


# ── Cache des sessions par worker ─────────────────────────────────────────────

# session_key → session_id (pour réutiliser les poids déjà poussés)
_worker_sessions: Dict[str, str] = {}
_worker_session_lock = threading.Lock()
_pool_registry: Dict[str, dict] = {}
_pool_registry_lock = threading.Lock()

# Incrémenter si la sémantique de la clé ou l'ordre des tranches change (sinon cache désaligné).
_SESSION_CACHE_KEY_VERSION = "v3-pool-registry"


def _model_fingerprint(model_config: dict) -> str:
    return (
        f"{MODEL_ID}|{model_config.get('model_type')}|"
        f"{model_config.get('num_hidden_layers_total')}|"
        f"{model_config.get('hidden_size')}|{model_config.get('vocab_size')}"
    )


def _register_pool(pool_id: str, data: dict) -> None:
    with _pool_registry_lock:
        existing = _pool_registry.get(pool_id, {})
        merged = {**existing, **data, "updated_at_ms": _now_ms()}
        _pool_registry[pool_id] = merged


def _decode_relay_json(response: dict) -> dict:
    try:
        inner_b64 = response.get("data_b64", "")
        if inner_b64:
            return json.loads(base64.b64decode(inner_b64).decode("utf-8", errors="replace"))
    except Exception:
        return {}
    return {}


def _model_prefix_cache_dir(model_key: str) -> str:
    safe_key = hashlib.sha256(model_key.encode("utf-8")).hexdigest()[:16]
    return os.path.join(PREFIX_CACHE_DIR, safe_key)


def _prefix_hash(token_ids: list[int], model_key: str) -> str:
    h = hashlib.sha256()
    h.update(model_key.encode("utf-8"))
    h.update(b":")
    h.update(",".join(str(t) for t in token_ids).encode("utf-8"))
    return h.hexdigest()


def _prefix_candidates(token_ids: list[int], model_key: str) -> list[dict[str, Any]]:
    if not PREFIX_CACHE or len(token_ids) < PREFIX_CACHE_MIN_TOKENS:
        return []
    root = _model_prefix_cache_dir(model_key)
    candidates: list[dict[str, Any]] = []
    now = _now_ms()
    with _prefix_cache_lock:
        if not os.path.isdir(root):
            return []
        for file_name in os.listdir(root):
            if not file_name.endswith(".json"):
                continue
            path = os.path.join(root, file_name)
            try:
                with open(path, "r") as f:
                    meta = json.load(f)
            except Exception:
                continue
            tokens_cached = int(meta.get("tokens_cached") or 0)
            if tokens_cached < PREFIX_CACHE_MIN_TOKENS or tokens_cached > len(token_ids):
                continue
            if now - int(meta.get("created_at_ms") or 0) > PREFIX_CACHE_TTL_SEC * 1000:
                continue
            if meta.get("prefix_hash") != _prefix_hash(token_ids[:tokens_cached], model_key):
                continue
            candidates.append(meta)
    return sorted(candidates, key=lambda m: int(m.get("tokens_cached") or 0), reverse=True)


def _prefix_cache_manifest_path(model_key: str, prefix_hash: str) -> str:
    return os.path.join(_model_prefix_cache_dir(model_key), f"{prefix_hash}.json")


def _write_prefix_cache_manifest(model_key: str, meta: dict[str, Any]) -> None:
    if not PREFIX_CACHE:
        return
    root = _model_prefix_cache_dir(model_key)
    with _prefix_cache_lock:
        os.makedirs(root, exist_ok=True)
        path = _prefix_cache_manifest_path(model_key, str(meta["prefix_hash"]))
        with open(path, "w") as f:
            json.dump(meta, f, ensure_ascii=False)


def _cache_control(
    routing_path: list[str],
    dtype: str,
    payload: dict[str, Any],
    timeout: float = 10.0,
) -> dict[str, Any]:
    results = []
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    for peer in routing_path:
        t0 = time.perf_counter()
        resp = _relay_raw(peer, dtype, raw, timeout=min(timeout, TIMEOUT))
        inner = _decode_relay_json(resp) if resp.get("ok") is not False else {}
        results.append({
            "peer": peer,
            "ok": resp.get("ok") is not False and inner.get("ok", True) is not False,
            "ms": int((time.perf_counter() - t0) * 1000),
            "data": inner,
            "error": resp.get("error") or inner.get("error"),
        })
    return {"ok": all(r["ok"] for r in results), "results": results}


def _measure_peer_latency(peer_id: str) -> dict[str, Any]:
    now = _now_ms()
    with _latency_lock:
        cached = _latency_cache.get(peer_id)
        if cached and now - int(cached.get("updated_at_ms", 0)) < 30_000:
            return dict(cached)

    payload = json.dumps({"ts_ms": now, "from": "vps-orchestrator"}).encode()
    t0 = time.perf_counter()
    response = _relay_raw(peer_id, "vryx.ping.peer", payload, timeout=min(5.0, TIMEOUT))
    rtt_ms = int((time.perf_counter() - t0) * 1000)
    ok = response.get("ok") is not False
    inner = _decode_relay_json(response) if ok else {}
    result = {
        "peer_id": peer_id,
        "vps_rtt_ms": rtt_ms if ok else None,
        "ok": ok,
        "worker_seen_ms": inner.get("received_ms"),
        "updated_at_ms": now,
    }
    with _latency_lock:
        _latency_cache[peer_id] = result
    return dict(result)


def _refresh_latency_matrix(peers: list[str]) -> dict[str, Any]:
    matrix: dict[str, Any] = {"vps_to_worker": {}, "worker_to_worker": {}, "updated_at_ms": _now_ms()}
    for peer in peers:
        matrix["vps_to_worker"][peer] = _measure_peer_latency(peer)
    use_full_ping = _use_full_worker_rtt_matrix()
    if not use_full_ping and len(peers) > 1:
        print(
            "[VPS] Placement hot-pool : RTT worker↔worker estimés (vite). "
            "Mesure exhaustive : VRYX_FULL_WORKER_RTT_MATRIX=1",
        )
    for src in peers:
        matrix["worker_to_worker"][src] = {}
        for dst in peers:
            if src == dst:
                matrix["worker_to_worker"][src][dst] = {"rtt_ms": 0, "estimated": False}
                continue
            if not use_full_ping:
                src_rtt = matrix["vps_to_worker"].get(src, {}).get("vps_rtt_ms")
                dst_rtt = matrix["vps_to_worker"].get(dst, {}).get("vps_rtt_ms")
                estimated = (
                    max(2, int((src_rtt + dst_rtt) / 2))
                    if isinstance(src_rtt, int) and isinstance(dst_rtt, int)
                    else 80
                )
                matrix["worker_to_worker"][src][dst] = {"rtt_ms": estimated, "estimated": True}
                continue
            payload = json.dumps({"ts_ms": _now_ms(), "from": src, "to": dst, "kind": "worker_to_worker"}).encode()
            t0 = time.perf_counter()
            response = _relay_raw(src, "vryx.ping.peer", payload, timeout=min(5.0, TIMEOUT), routing_path=[dst])
            rtt_ms = int((time.perf_counter() - t0) * 1000)
            if response.get("ok") is not False:
                matrix["worker_to_worker"][src][dst] = {"rtt_ms": rtt_ms, "estimated": False}
                continue
            src_rtt = matrix["vps_to_worker"].get(src, {}).get("vps_rtt_ms")
            dst_rtt = matrix["vps_to_worker"].get(dst, {}).get("vps_rtt_ms")
            estimated_fallback = max(1, int((src_rtt + dst_rtt) / 2)) if isinstance(src_rtt, int) and isinstance(dst_rtt, int) else None
            matrix["worker_to_worker"][src][dst] = {"rtt_ms": estimated_fallback, "estimated": True, "error": response.get("error")}
    return matrix


def _latency_penalty(peer_id: str, latency_matrix: dict[str, Any]) -> float:
    rtt = (latency_matrix.get("vps_to_worker", {}).get(peer_id) or {}).get("vps_rtt_ms")
    if not isinstance(rtt, int):
        return HOT_POOL_MAX_RTT_MS
    if rtt <= HOT_POOL_IDEAL_RTT_MS:
        return 0.0
    return min(float(rtt), HOT_POOL_MAX_RTT_MS * 4)


def _hot_pool_score(peer_id: str, catalog: dict[str, dict], latency_matrix: dict[str, Any]) -> float:
    return _worker_weight(peer_id, catalog) - (_latency_penalty(peer_id, latency_matrix) / 10.0)


def _stream_control(routing_path: list[str], session_id: str, pool_id: str, mode: str, hidden_transport: str | None = None) -> dict[str, Any]:
    transport = _normalize_hidden_transport(hidden_transport)
    results = []
    stream_payload: dict[str, Any] = {
        "session_id": session_id,
        "pool_id": pool_id,
        "routing_path": routing_path,
        "stream_mode": PIPELINE_STREAM_MODE,
        "hidden_transport": transport,
        "hidden_quic": HIDDEN_QUIC,
        "persistent_relay": PERSISTENT_RELAY,
        "pipeline_overlap": PIPELINE_OVERLAP,
    }
    if HIDDEN_MICROCHUNK_BYTES > 0:
        stream_payload["hidden_microchunk_bytes"] = HIDDEN_MICROCHUNK_BYTES
    payload = json.dumps(stream_payload).encode()
    dtype = f"vryx.stream.{mode}"
    for peer in routing_path:
        t0 = time.perf_counter()
        resp = _relay_raw(peer, dtype, payload, timeout=min(10.0, TIMEOUT))
        results.append({
            "peer": peer,
            "ok": resp.get("ok") is not False,
            "ms": int((time.perf_counter() - t0) * 1000),
            "relay_ms": resp.get("relay_ms"),
            "serialization_ms": resp.get("serialization_ms"),
            "hidden_bytes": resp.get("hidden_bytes"),
            "persistent_relay": resp.get("persistent_relay", PERSISTENT_RELAY),
            "connection_reuse": resp.get("connection_reuse", PERSISTENT_RELAY),
            "error": resp.get("error"),
        })
    return {
        "mode": dtype,
        "results": results,
        "ok": all(r.get("ok") for r in results),
        "quic_requested": HIDDEN_QUIC,
        "quic_used": False,
        "persistent_relay": PERSISTENT_RELAY,
        "connection_reuse": PERSISTENT_RELAY,
        "pipeline_overlap": PIPELINE_OVERLAP,
        "fallback": "persistent_request_response" if PERSISTENT_RELAY else "request_response",
        "fallback_reason": "native_quic_not_selected" if HIDDEN_QUIC else "quic_disabled",
    }


def _quic_probe(routing_path: list[str], session_id: str, pool_id: str, hidden_transport: str | None = None) -> dict[str, Any]:
    if not HIDDEN_QUIC:
        return {"ok": True, "enabled": False, "quic_available": False, "quic_used": False, "results": []}
    payload = {
        "session_id": session_id,
        "pool_id": pool_id,
        "routing_path": routing_path,
        "hidden_transport": _normalize_hidden_transport(hidden_transport),
    }
    result = _cache_control(routing_path, "vryx.quic.probe", payload)
    available = all((r.get("data") or {}).get("quic_available") for r in result.get("results", []))
    return {
        "ok": result.get("ok", False),
        "enabled": True,
        "quic_available": available,
        "quic_used": available,
        "fallback": "request_response",
        "fallback_reason": None if available else "native_quic_transport_not_available",
        "results": result.get("results", []),
    }


def _query_worker_status(peer_id: str, session_id: str = "") -> dict:
    payload = json.dumps({"session_id": session_id}).encode()
    r = _relay_raw(peer_id, "vryx.shard.status", payload, timeout=min(SHARD_STATUS_TIMEOUT, TIMEOUT))
    if r.get("ok") is False:
        return {"ok": False, "peer_id": peer_id, "error": r.get("error", "status indisponible")}
    status = _decode_relay_json(r)
    status.setdefault("ok", True)
    status["peer_id"] = peer_id
    return status


def _is_unknown_session_error(value: Any) -> bool:
    text = str(value or "").lower()
    return "session" in text and ("inconnue" in text or "unknown" in text or "not found" in text)


def _session_ready_from_status(status: dict[str, Any], session_id: str) -> tuple[bool, str | None, dict[str, Any] | None]:
    if not status.get("ok", True):
        return False, str(status.get("error") or "status_unavailable"), None
    shards = status.get("shards") if isinstance(status, dict) else []
    if not isinstance(shards, list):
        return False, "status_shards_invalid", None
    for shard in shards:
        if not isinstance(shard, dict) or shard.get("session_id") != session_id:
            continue
        ready = bool(shard.get("ready") or shard.get("built") or shard.get("build_ready"))
        weights_loaded = int(shard.get("weights_loaded") or 0)
        if ready and weights_loaded > 0:
            return True, None, shard
        return False, "shard_not_ready", shard
    return False, "session_unknown_on_worker", None


def _classify_runtime_pool(statuses: list[dict[str, Any]], session_id: str, requested_pool_class: str) -> dict[str, Any]:
    worker_runtime: dict[str, str] = {}
    worker_attention: dict[str, str] = {}
    worker_linear_ready: dict[str, bool] = {}
    ready_workers = 0
    reasons: list[str] = []

    for status in statuses:
        peer = str(status.get("peer_id") or "")
        ready, reason, shard = _session_ready_from_status(status, session_id)
        if ready:
            ready_workers += 1
        elif reason:
            reasons.append(f"{_short(peer)}:{reason}")
        runtime = str((shard or {}).get("runtime_backend") or "unknown").lower()
        attention = str((shard or {}).get("attention_backend") or "unknown").lower()
        linear_ready = bool((shard or {}).get("linear_attn_ready"))
        worker_runtime[peer] = runtime
        worker_attention[peer] = attention
        worker_linear_ready[peer] = linear_ready

    all_ready = ready_workers == len(statuses) and bool(statuses)
    all_mlx = all_ready and all(v == "mlx" for v in worker_runtime.values())
    all_mlx_metal = all_ready and all(v == "mlx_metal" for v in worker_attention.values())
    all_vllm = all_ready and all(v == "vllm" for v in worker_runtime.values())
    all_paged_attention = all_ready and all(v == "paged_attention" for v in worker_attention.values())
    all_linear = all_ready and all(worker_linear_ready.values())
    if all_mlx and all_mlx_metal:
        actual_pool_class = "velocity_mlx"
    elif all_vllm and all_paged_attention:
        actual_pool_class = "velocity_vllm"
    else:
        actual_pool_class = "legacy_pytorch"
        if requested_pool_class == "velocity_mlx" and not all_mlx:
            reasons.append("runtime_status_not_mlx")
        if requested_pool_class == "velocity_mlx" and not all_mlx_metal:
            reasons.append("attention_backend_not_mlx_metal")
        if requested_pool_class == "velocity_mlx" and not all_linear:
            reasons.append("linear_attn_not_ready")
        if requested_pool_class == "velocity_vllm" and not all_vllm:
            reasons.append("runtime_status_not_vllm")
        if requested_pool_class == "velocity_vllm" and not all_paged_attention:
            reasons.append("attention_backend_not_paged_attention")

    return {
        "requested_pool_class": requested_pool_class,
        "actual_pool_class": actual_pool_class,
        "ready": all_ready,
        "ready_workers": ready_workers,
        "worker_count": len(statuses),
        "runtime_backend_per_worker": worker_runtime,
        "attention_backend_per_worker": worker_attention,
        "linear_attn_ready_per_worker": worker_linear_ready,
        "linear_attn_ready": all_linear,
        "fallback_reason": ";".join(dict.fromkeys(reasons)) if reasons else None,
    }


def _validate_cached_session(peers: list[str], session_id: str, requested_pool_class: str) -> dict[str, Any]:
    statuses = [_query_worker_status(peer, session_id) for peer in peers]
    truth = _classify_runtime_pool(statuses, session_id, requested_pool_class)
    truth["worker_statuses"] = statuses
    truth["cache_valid"] = bool(truth["ready"])
    return truth


def _invalidate_worker_session_cache(key: str, pool_id: str, reason: str, session_id: str = "") -> None:
    with _worker_session_lock:
        cached = _worker_sessions.get(key)
        if not session_id or cached == session_id:
            _worker_sessions.pop(key, None)
        if session_id:
            for cached_key, cached_session in list(_worker_sessions.items()):
                if cached_session == session_id:
                    _worker_sessions.pop(cached_key, None)
    _register_pool(pool_id, {
        "status": "invalidated",
        "ready": False,
        "session_status": "invalidated",
        "invalidation_reason": reason,
        "invalidated_session_id": session_id,
    })


def get_pool_snapshot() -> dict:
    peers = sorted(_discover_live_peers())
    catalog = _fetch_worker_catalog()
    latency_matrix = _refresh_latency_matrix(peers) if peers else {"vps_to_worker": {}, "worker_to_worker": {}}
    with _pool_registry_lock:
        pools = [dict(v) for v in _pool_registry.values()]
    for pool in pools:
        session_id = str(pool.get("session_id") or "")
        statuses = []
        for peer in pool.get("routing_path") or []:
            if peer in peers:
                statuses.append(_query_worker_status(peer, session_id))
        if statuses:
            pool["worker_statuses"] = statuses
            pool["ready_workers"] = sum(1 for s in statuses if s.get("ok") and s.get("count", 0) > 0)
            pool["ready"] = pool["ready_workers"] >= len(pool.get("routing_path") or [])
    total_vram = sum(int((catalog.get(p) or {}).get("gpuVramMb") or 0) for p in peers)
    return {
        "ok": True,
        "model_id": MODEL_ID,
        "model_fingerprint": _model_fingerprint(_model_config_cache or {}),
        "peers": peers,
        "workers": [catalog.get(p, {"peerId": p}) for p in peers],
        "total_vram_mb": total_vram,
        "peer_latency_matrix": latency_matrix,
        "hot_pool_rtt_target_ms": HOT_POOL_IDEAL_RTT_MS,
        "hot_pool_rtt_max_ms": HOT_POOL_MAX_RTT_MS,
        "feature_flags": {
            "hidden_quic": HIDDEN_QUIC,
            "prefix_cache": PREFIX_CACHE,
            "prefix_cache_ttl_sec": PREFIX_CACHE_TTL_SEC,
            "prefix_cache_min_tokens": PREFIX_CACHE_MIN_TOKENS,
            "speculative_heads": SPECULATIVE_HEADS,
            "continuous_batching": CONTINUOUS_BATCHING,
            "chunked_prefill": CHUNKED_PREFILL,
            "prefill_chunk_tokens": PREFILL_CHUNK_TOKENS,
            "ring_attention": RING_ATTENTION,
            "persistent_relay": PERSISTENT_RELAY,
            "pipeline_overlap": PIPELINE_OVERLAP,
            "pipeline_chain_mode": PIPELINE_CHAIN_MODE,
        },
        "pool_ttl_sec": POOL_TTL,
        "replication_factor": POOL_REPLICATION_FACTOR,
        "pools": pools,
        "updated_at_ms": _now_ms(),
    }


def _pool_for_session(session_id: str) -> dict:
    with _pool_registry_lock:
        for pool in _pool_registry.values():
            if pool.get("session_id") == session_id:
                return dict(pool)
    return {}


def _failover_routing_path(routing_path: list[str], session_id: str, pool_info: dict) -> Optional[list[str]]:
    """Remplace le dernier hop par un réplica prêt du shard lm_head si disponible."""
    replicas = pool_info.get("replicas") or []
    for replica in replicas:
        peer = str(replica.get("peer") or "")
        if not peer or peer in routing_path:
            continue
        if not replica.get("ready"):
            continue
        status = _query_worker_status(peer, session_id)
        shards = status.get("shards") if isinstance(status, dict) else []
        if isinstance(shards, list) and any(s.get("has_lm_head") and s.get("ready") for s in shards if isinstance(s, dict)):
            new_path = list(routing_path)
            new_path[-1] = peer
            return new_path
    return None


def _get_or_create_session(
    peers: list[str],
    model_config: dict,
    model_manifest: dict,
    hidden_transport: str | None = None,
    pool_class: str = "legacy_pytorch",
) -> tuple[Optional[str], str, list[dict[str, Any]]]:
    """
    Retourne (session_id, statut, diag préparation) avec statut parmi 'reused', 'created', 'failed'.
    diag : entrées structurées uniquement si création de session a échoué (sinon liste vide).
    """
    transport = _normalize_hidden_transport(hidden_transport)
    # Toujours la même clé et le même ordre de tranches que routing_path (pairs triés).
    model_key = _model_fingerprint(model_config)
    catalog = _fetch_worker_catalog()
    latency_matrix = _refresh_latency_matrix(peers)
    key = _SESSION_CACHE_KEY_VERSION + "|" + pool_class + "|" + model_key + "|" + "|".join(peers)
    pool_id = "pool-" + str(abs(hash(key)))[:12]
    with _worker_session_lock:
        if key in _worker_sessions:
            print(f"[VPS] Réutilisation session pour {len(peers)} workers")
            session_id = _worker_sessions[key]
            with _pool_registry_lock:
                existing_pool = dict(_pool_registry.get(pool_id, {}))
            sticky_path = list(existing_pool.get("routing_path") or peers)
            validation = _validate_cached_session(sticky_path, session_id, pool_class)
            if not validation.get("cache_valid"):
                reason = validation.get("fallback_reason") or "cached_session_not_ready"
                print(f"[VPS] Session hot obsolète {session_id[:16]}… invalidée : {reason}")
                _worker_sessions.pop(key, None)
                _register_pool(pool_id, {
                    "status": "invalidated",
                    "ready": False,
                    "session_status": "invalidated",
                    "invalidation_reason": reason,
                    "invalidated_session_id": session_id,
                    "pool_validation": validation,
                })
            else:
                peers[:] = sticky_path
                actual_pool_class = str(validation.get("actual_pool_class") or pool_class)
                validation_reason = validation.get("fallback_reason")
                if actual_pool_class != pool_class:
                    print(
                        f"[VPS] Pool réel {actual_pool_class} au lieu de {pool_class} "
                        f"({validation_reason or 'runtime_status_mismatch'})"
                    )
                _register_pool(pool_id, {
                    "pool_id": pool_id,
                    "pool_class": pool_class,
                    "actual_pool_class": actual_pool_class,
                    "runtime_backend": _runtime_for_pool(actual_pool_class),
                    "session_id": session_id,
                    "model_id": MODEL_ID,
                    "model_fingerprint": model_key,
                    "routing_path": sticky_path,
                    "status": "hot",
                    "session_status": "reused",
                    "last_reused_ms": _now_ms(),
                    "pool_validation": validation,
                    "pool_fallback_reason": validation_reason,
                })
                return session_id, "reused", []

        session_id = f"vryx-{int(time.time() * 1000)}"
        n = len(peers)
        total_layers = model_config["num_hidden_layers_total"]
        # Hot Pool Placement : latence d'abord, puis VRAM/GPU. Le dernier worker garde lm_head.
        ranked = sorted(peers, key=lambda p: (_hot_pool_score(p, catalog, latency_matrix), p), reverse=True)
        if n >= 2:
            last_peer = ranked[0]
            first_peer = ranked[1]
            middle = [p for p in ranked[2:] if p not in (first_peer, last_peer)]
            ordered = [first_peer] + sorted(middle, key=lambda p: (_hot_pool_score(p, catalog, latency_matrix), p), reverse=True) + [last_peer]
        else:
            ordered = ranked
        counts = _weighted_counts(total_layers, ordered, catalog)
        if n >= 3 and model_config.get("model_type") != "gpt2":
            # Le dernier worker porte aussi norm + lm_head : on évite de lui ajouter trop de couches.
            max_last_layers = min(2, total_layers)
            if counts[-1] > max_last_layers:
                overflow = counts[-1] - max_last_layers
                counts[-1] = max_last_layers
                for j in range(overflow):
                    counts[j % (n - 1)] += 1

        assignments = []
        start = 0
        for i, peer in enumerate(ordered):
            n_layers = counts[i]
            end = start + n_layers - 1
            assignments.append((peer, start, end, i == 0, i == n - 1))
            start = end + 1
        peers[:] = ordered

        # Purge des anciens shards pour libérer /tmp avant d'écrire les nouveaux
        _purge_old_shards(keep_session=session_id)

        _register_pool(pool_id, {
            "pool_id": pool_id,
            "pool_class": pool_class,
            "runtime_backend": _runtime_for_pool(pool_class),
            "session_id": session_id,
            "model_id": MODEL_ID,
            "model_fingerprint": model_key,
            "routing_path": peers,
            "status": "warming",
            "session_status": "creating",
            "replication_factor": POOL_REPLICATION_FACTOR,
            "assignments": [
                {
                    "peer": peer,
                    "rank": i,
                    "layer_start": ls,
                    "layer_end": le,
                    "num_layers": max(0, le - ls + 1),
                    "has_embedding": has_emb,
                    "has_lm_head": has_head,
                    "weight": _worker_weight(peer, catalog),
                    "hot_pool_score": _hot_pool_score(peer, catalog, latency_matrix),
                    "vps_rtt_ms": (latency_matrix.get("vps_to_worker", {}).get(peer) or {}).get("vps_rtt_ms"),
                    "gpu": (catalog.get(peer) or {}).get("gpuName"),
                    "vram_mb": (catalog.get(peer) or {}).get("gpuVramMb"),
                    "runtime_backend": _runtime_for_pool(pool_class, catalog.get(peer) or {}),
                    "weight_quantization": (catalog.get(peer) or {}).get("weightQuantization") or os.environ.get("VRYX_WEIGHT_QUANTIZATION", "fp16"),
                    "attention_backend": _attention_for_pool(pool_class),
                }
                for i, (peer, ls, le, has_emb, has_head) in enumerate(assignments)
            ],
            "created_at_ms": _now_ms(),
            "peer_latency_matrix": latency_matrix,
            "hot_pool_ready": all(
                ((latency_matrix.get("vps_to_worker", {}).get(peer) or {}).get("vps_rtt_ms") or HOT_POOL_MAX_RTT_MS)
                <= HOT_POOL_MAX_RTT_MS
                for peer in peers
            ),
        })

        print(f"[VPS] Préparation poids pour {n} workers (session {session_id[:20]})…")
        prep_diag: list[dict[str, Any]] = []

        def _init_worker(
            i: Any,
            peer: str,
            ls: int,
            le: int,
            has_emb: bool,
            has_head: bool,
            download_url: str,
            diag: list[dict[str, Any]],
        ) -> bool:
            init_payload = json.dumps({
                "session_id": session_id,
                "pool_id": pool_id,
                "model_id": MODEL_ID,
                "layer_start": ls,
                "layer_end": le,
                "model_config": model_config,
                "has_embedding": has_emb,
                "has_lm_head": has_head,
                "ttl_sec": POOL_TTL,
                "download_url": download_url,
                "async_load": True,
                "hidden_transport": transport,
                "weight_quantization": os.environ.get("VRYX_WEIGHT_QUANTIZATION", "fp16").lower(),
                "runtime_backend": _runtime_for_pool(pool_class),
                "supports_q4_weights": pool_class == "velocity_mlx" or os.environ.get("VRYX_SUPPORTS_Q4_WEIGHTS", "0").lower() in ("1", "true", "yes"),
                "supports_mlx": pool_class == "velocity_mlx" or os.environ.get("VRYX_SUPPORTS_MLX", "0").lower() in ("1", "true", "yes"),
                "supports_vllm": pool_class == "velocity_vllm" or os.environ.get("VRYX_SUPPORTS_VLLM", "0").lower() in ("1", "true", "yes"),
                "pipeline_stream_mode": PIPELINE_STREAM_MODE,
                "worker_kv_cache": WORKER_KV_CACHE,
                "hidden_quic": HIDDEN_QUIC,
                "prefix_cache": PREFIX_CACHE,
                "speculative_heads": SPECULATIVE_HEADS,
                "continuous_batching": CONTINUOUS_BATCHING,
                "chunked_prefill": CHUNKED_PREFILL,
                "ring_attention": RING_ATTENTION,
            }).encode()
            
            relay_ok = False
            r: dict[str, Any] = {}
            elapsed = 0
            for attempt in range(6):
                t0 = time.perf_counter()
                r = _relay_raw(peer, "vryx.shard.init", init_payload, timeout=TIMEOUT * 2)
                elapsed = int((time.perf_counter() - t0) * 1000)
                relay_ok = r.get("ok") is not False and not str(r.get("error") or "").strip()
                if relay_ok:
                    break
                print(f"[VPS] Worker {i} ({peer[:16]}) relay failed (attempt {attempt+1}/6) : {r.get('error')}")
                time.sleep(min(12.0, 1.5 * (attempt + 1)))
                
            if relay_ok:
                try:
                    inner_b64 = r.get("data_b64", "")
                    inner = json.loads(base64.b64decode(inner_b64).decode("utf-8", errors="replace")) if inner_b64 else {}
                    weights_loaded = inner.get("weights_loaded", 0)
                    inner_ok = inner.get("ok", True)
                    print(f"[VPS] Worker {i} ({peer[:16]}) : init accepté en {elapsed}ms")
                    if not inner_ok:
                        det = str(inner.get("error") or inner)[:500]
                        if "transport error" in det.lower() or "connection refused" in det.lower():
                            det += (
                                " · Indice : le rust-daemon du worker (Mac) n’a pas pu parler au "
                                "`inference_server.py` local (127.0.0.1:gRPC du worker). "
                                "Redémarrer les workers MLX, ou vérifier quota disque/logs Python."
                            )
                        diag.append({
                            "worker_index": i,
                            "peer": peer[:48],
                            "phase": "worker_init_denied",
                            "detail": det[:700],
                            "manifest_url_preview": download_url[:120],
                        })
                        return False
                    wait_started = time.perf_counter()
                    poll_n = 0
                    last_reason: str | None = None
                    while time.perf_counter() - wait_started < max(TIMEOUT * 2, 1800.0):
                        status = _query_worker_status(peer, session_id)
                        ready, reason, shard_hit = _session_ready_from_status(status, session_id)
                        if ready and shard_hit is not None:
                            weights_loaded = shard_hit.get("weights_loaded", weights_loaded)
                            print(
                                f"[VPS] Worker {i} ({peer[:16]}) prêt : "
                                f"{weights_loaded} poids, build={shard_hit.get('build_ms')}ms"
                            )
                            return True
                        last_reason = reason or (
                            str(status.get("error")) if not status.get("ok", True) else last_reason
                        )
                        poll_n += 1
                        time.sleep(_shard_ready_sleep_sec(poll_n))
                    print(f"[VPS] Worker {i} ({peer[:16]}) timeout readiness après init")
                    diag.append({
                        "worker_index": i,
                        "peer": peer[:48],
                        "phase": "ready_poll_timeout",
                        "detail": (last_reason or "session_not_ready")[:500],
                        "manifest_url_preview": download_url[:120],
                    })
                    return False
                except Exception as e:
                    print(f"[VPS] Worker {i} parse response error : {e}")
                    diag.append({
                        "worker_index": i,
                        "peer": peer[:48],
                        "phase": "init_response_parse",
                        "detail": str(e)[:500],
                    })
                    return False
            else:
                print(f"[VPS] Worker {i} ({peer[:16]}) relay failed : {r.get('error')}")
                diag.append({
                    "worker_index": i,
                    "peer": peer[:48],
                    "phase": "relay_shard_init",
                    "detail": str(r.get("error") or "relay_failed")[:500],
                })
                return False

        init_jobs: list[tuple[Any, str, int, int, bool, bool, str]] = []
        for i, (peer, ls, le, has_emb, has_head) in enumerate(assignments):
            download_url = _save_shard_to_disk_from_safetensors(
                session_id, i, ls, le, has_emb, has_head, model_manifest, model_config
            )
            init_jobs.append((i, peer, ls, le, has_emb, has_head, download_url))

        def _run_init_job(job: tuple[Any, str, int, int, bool, bool, str]) -> bool:
            ij, peer_j, ls_j, le_j, emb_j, head_j, url_j = job
            try:
                return _init_worker(ij, peer_j, ls_j, le_j, emb_j, head_j, url_j, prep_diag)
            finally:
                _delete_temp_shard_files(session_id, ij)

        if PARALLEL_SHARD_INIT and len(init_jobs) > 1:
            max_workers = min(PARALLEL_SHARD_INIT_MAX, len(init_jobs))
            print(f"[VPS] Init parallèle des workers (max_workers={max_workers})…")
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                results = list(executor.map(_run_init_job, init_jobs))
        else:
            results = [_run_init_job(j) for j in init_jobs]

        # Création séquentielle des shards sur disque VPS ; relay + poll ready ci-dessus (séquentiel ou parallèle selon env).
        if not all(results):
            print("[VPS] Certains workers n'ont pas reçu leurs poids.")
            _register_pool(pool_id, {"status": "failed", "session_status": "failed", "shard_prep_diag": prep_diag})
            return None, "failed", prep_diag

        replicas = []
        if POOL_REPLICATION_FACTOR > 0:
            extra_peers = [p for p in sorted(_discover_live_peers()) if p not in peers]
            critical = [a for a in assignments if a[4]] or assignments[-1:]
            for rep_i, peer in enumerate(extra_peers[:POOL_REPLICATION_FACTOR]):
                _, ls, le, _has_emb, has_head = critical[rep_i % len(critical)]
                download_url = _save_shard_to_disk_from_safetensors(
                    session_id, f"replica-{rep_i}", ls, le, False, has_head, model_manifest, model_config
                )
                try:
                    ok = _init_worker(f"replica-{rep_i}", peer, ls, le, False, has_head, download_url, prep_diag)
                finally:
                    _delete_temp_shard_files(session_id, f"replica-{rep_i}")
                replicas.append({
                    "peer": peer,
                    "layer_start": ls,
                    "layer_end": le,
                    "has_lm_head": has_head,
                    "ready": bool(ok),
                    "source": "critical_lm_head",
                })

        validation = _validate_cached_session(peers, session_id, pool_class)
        actual_pool_class = str(validation.get("actual_pool_class") or pool_class)
        validation_reason = validation.get("fallback_reason")
        if pool_class == "velocity_mlx" and actual_pool_class != "velocity_mlx":
            print(
                f"[VPS] Pool MLX demandé mais pool réel={actual_pool_class} "
                f"raison={validation_reason or 'runtime_status_mismatch'}"
            )
        _worker_sessions[key] = session_id
        _register_pool(pool_id, {
            "status": "hot",
            "session_status": "created",
            "ready": bool(validation.get("ready", True)),
            "actual_pool_class": actual_pool_class,
            "pool_validation": validation,
            "pool_fallback_reason": validation_reason,
            "replicas": replicas,
        })
        # TTL logique long : les workers gardent le modèle résident, sauf expiration explicite.
        def _expire():
            time.sleep(POOL_TTL)
            with _worker_session_lock:
                _worker_sessions.pop(key, None)
            _register_pool(pool_id, {"status": "expired", "ready": False})
        threading.Thread(target=_expire, daemon=True).start()

        return session_id, "created", []


# ── Boucle autorégressive ─────────────────────────────────────────────────────

def _run_mlx_lm_direct_chat(
    prompt: str,
    tokenizer: Any,
    peers: list[str],
    decode_cap: int,
    requested_quantization: str,
    pool_preference: str,
) -> Optional[dict[str, Any]]:
    if not MLX_LM_DIRECT or not peers:
        return None
    peer = peers[0]
    payload = {
        "model_id": MODEL_ID,
        "prompt": prompt,
        "max_new_tokens": decode_cap,
        "temperature": SAMPLING_TEMPERATURE,
        "top_p": SAMPLING_TOP_P,
        "top_k": SAMPLING_TOP_K,
    }
    t0 = time.perf_counter()
    relay = _relay_raw(peer, "vryx.mlx_lm.generate", json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout=PIPELINE_STEP_TIMEOUT)
    wall_ms = max(1, int((time.perf_counter() - t0) * 1000))
    response = _decode_pipeline_response(relay)
    relay_ms = int(relay.get("relay_ms") or wall_ms)
    if not response:
        return {
            "ok": False,
            "text": "",
            "error": relay.get("error") or "Réponse mlx-lm directe vide",
            "trace": {
                "layout": "mlx_lm_direct_p2p",
                "ok": False,
                "routing_path": [peer],
                "peers": [peer],
                "relay": relay,
                "compute_time_ms": wall_ms,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }
    if response.get("ok") is False:
        return {
            "ok": False,
            "text": "",
            "error": str(response.get("error") or "mlx-lm direct failed"),
            "trace": {
                "layout": "mlx_lm_direct_p2p",
                "ok": False,
                "routing_path": [peer],
                "peers": [peer],
                "relay_ms": relay_ms,
                "worker_response": response,
                "compute_time_ms": wall_ms,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }

    text = str(response.get("text") or "")
    completion_tokens = int(response.get("completion_tokens") or 0)
    try:
        prompt_tokens = len(tokenizer.encode(prompt))
    except Exception:
        prompt_tokens = 0
    generation_ms = max(1, int(response.get("generation_ms") or wall_ms))
    actual_tps = round(completion_tokens * 1000.0 / generation_ms, 3) if completion_tokens else 0
    trace = {
        "layout": "mlx_lm_direct_p2p",
        "ok": True,
        "routing_path": [peer],
        "peers": [peer],
        "model_id": MODEL_ID,
        "runtime_backend_per_worker": {peer: "mlx_lm"},
        "pool_preference": pool_preference,
        "requested_quantization": requested_quantization,
        "effective_quantization": "mlx_lm_native",
        "compute_time_ms": generation_ms,
        "relay_ms": relay_ms,
        "setup_ms": int(response.get("load_ms") or 0),
        "tokens_generated": completion_tokens,
        "hot_path_tps": actual_tps,
        "benchmark": {
            "target_tps": 15,
            "target_ms_per_token": 66,
            "actual_ms_per_token": int(generation_ms / completion_tokens) if completion_tokens else 0,
            "actual_tps": actual_tps,
            "decode_mode": response.get("decode_mode") or "mlx_lm_direct_stream_generate",
            "routing_hops": 1,
            "relay_ms": relay_ms,
            "ttft_ms": response.get("ttft_ms"),
            "load_ms": response.get("load_ms"),
            "runtime_backend": "mlx_lm",
        },
        "metrics": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "vps_delegate_ms": 0,
        },
    }
    return {
        "ok": True,
        "text": _clean_response_text(text),
        "trace": trace,
        "metrics": trace["metrics"],
    }


def run_pipeline_chat(prompt: str, options: Optional[dict[str, Any]] = None) -> dict:
    """
    Pipeline Parallelism réel :
      - VPS tokenise
      - Workers 1→2→3 exécutent chacun leur tranche de couches
      - Dernier worker retourne next_token_id
      - VPS dé-tokenise, boucle jusqu'à EOS
    """
    options = options or {}
    requested_quantization = _normalize_hidden_transport(
        options.get("hidden_transport") or options.get("quantization") or HIDDEN_TRANSPORT
    )
    hidden_transport = requested_quantization
    quantization_fallback_reason: Optional[str] = None
    pool_preference = _normalize_pool_preference(options.get("pool_preference"))
    pool_fallback_reason: Optional[str] = None

    decode_cap = MAX_NEW_TOKENS
    _mnt = options.get("max_new_tokens")
    if _mnt is not None:
        try:
            raw_cap = int(_mnt)
            if raw_cap >= 1:
                decode_cap = min(MAX_NEW_TOKENS, raw_cap)
        except (TypeError, ValueError):
            pass

    model_manifest, tokenizer = _ensure_model()
    if model_manifest is None or tokenizer is None:
        return {
            "ok": False,
            "text": "",
            "error": f"Modèle {MODEL_ID} non disponible. Vérifier le téléchargement.",
            "trace": {"layout": "pipeline_relay_daisy_chain", "ok": False},
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    peers_raw = _discover_live_peers()
    # Ordre canonique : même ordre à chaque requête et pour les tranches shard.init (embedding → … → lm_head).
    # Sinon la clé de cache (sorted) peut correspondre à une autre permutation et le 1er hop reçoit token_ids
    # sur un worker « milieu » → pas de next_token_id, texte vide, message générique côté API.
    peers_sorted = sorted(peers_raw)
    catalog = _fetch_worker_catalog()
    incompatible_model_peers: list[dict[str, Any]] = []
    if REQUIRE_WORKER_MODEL_MATCH and catalog:
        compatible_peers: list[str] = []
        for peer in peers_sorted:
            worker = catalog.get(peer) or {}
            if _worker_matches_model(worker):
                compatible_peers.append(peer)
            else:
                incompatible_model_peers.append({
                    "peer_id": peer,
                    "model": worker.get("model") or worker.get("model_id") or "unknown",
                    "runtime": worker.get("runtimeBackend") or worker.get("runtime_backend") or "unknown",
                })
        peers_sorted = compatible_peers
    selected_peers, pool_class, pool_fallback_reason = _select_pool_peers(peers_sorted, catalog, pool_preference)
    peers_sorted = sorted(selected_peers)
    peers_sorted = _filter_workers_by_catalog_public_ip_optional(peers_sorted, catalog)
    if len(peers_sorted) < MIN_WORKERS:
        # Pas assez de workers : retourne une ERREUR explicite (le VPS ne calcule jamais)
        mismatch_note = ""
        if incompatible_model_peers:
            advertised = ", ".join(
                f"{str(p['peer_id'])[:12]}…={p['model']}" for p in incompatible_model_peers[:4]
            )
            mismatch_note = f" Workers incompatibles ignorés : {advertised}."
        return {
            "ok": False,
            "text": "",
            "error": (
                f"Pas assez de workers connectés ({len(peers_sorted)}/{MIN_WORKERS} minimum). "
                f"Vérifiez les heartbeats vers l’API, le bootstrap P2P et le modèle déclaré ({MODEL_ID})."
                f"{mismatch_note}"
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "peers": peers_sorted,
                "routing_path": peers_sorted,
                "min_workers_required": MIN_WORKERS,
                "required_model": MODEL_ID,
                "incompatible_model_peers": incompatible_model_peers,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    direct_result = _run_mlx_lm_direct_chat(
        prompt,
        tokenizer,
        peers_sorted,
        decode_cap,
        requested_quantization,
        pool_preference,
    )
    if direct_result is not None:
        return direct_result

    n = _routing_pipeline_width(len(peers_sorted))
    peers = peers_sorted[:n]
    model_config = _model_config_cache

    # Sur runtime MLX, hidden q4/int8 compresse les états ; la restauration peut brouiller fortement
    # les logits alors que les poids sont en fp16 → texte multilingue aberrant. fp16 coûte plus de
    # bande passante P2P mais reste fiable. Désactiver : VRYX_MLX_ALLOW_Q4_HIDDEN=1.
    if (
        pool_class == "velocity_mlx"
        and hidden_transport in ("q4", "int8")
        and os.environ.get("VRYX_MLX_ALLOW_Q4_HIDDEN", "").strip().lower() not in ("1", "true", "yes")
    ):
        hidden_transport = "fp16"
        quantization_fallback_reason = "mlx_hidden_fp16_quality_guard"

    # Obtenir / créer la session de poids
    t_setup = time.perf_counter()
    session_id, sess_status, shard_prep_diag = _get_or_create_session(
        peers, model_config, model_manifest, hidden_transport, pool_class
    )
    setup_ms = int((time.perf_counter() - t_setup) * 1000)
    if sess_status == "failed" or session_id is None:
        detail_hint = ""
        if shard_prep_diag:
            chunk = "; ".join(
                f"w{d.get('worker_index')}:{d.get('phase')}:{str(d.get('detail',''))[:100]}"
                for d in shard_prep_diag[:3]
            )
            detail_hint = f" Diagnostics orchestrateur : {chunk}."
        return {
            "ok": False,
            "text": "",
            "error": (
                "Échec de préparation des shards sur les workers (téléchargement ou build). "
                "Vérifier les workers, l'espace disque VPS (VRYX_SHARD_BASE_DIR) et les URLs téléchargeables depuis les GPUs "
                "(VRYX_SHARD_DOWNLOAD_BASE_URL / domaine exposant /api/internal/shard-serve/…)." + detail_hint
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": peers,
                "peers": peers,
                "setup_ms": setup_ms,
                "session_status": sess_status,
                "shard_prep_diag": shard_prep_diag,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
    if sess_status == "created":
        print(f"[VPS] Setup poids en {setup_ms}ms")
    pool_info = _pool_for_session(session_id)
    stream_open = {"ok": False, "results": []}
    pool_id = str(pool_info.get("pool_id") or "")
    if hidden_transport == "q4":
        unsupported = []
        for peer in peers:
            status = _query_worker_status(peer, session_id)
            shards = status.get("shards") if isinstance(status, dict) else []
            if not isinstance(shards, list) or not any(
                isinstance(shard, dict) and shard.get("q4_supported") is True for shard in shards
            ):
                unsupported.append(peer)
        if unsupported:
            hidden_transport = "int8"
            quantization_fallback_reason = "worker_q4_unsupported"
    linear_attn_ready = True
    runtime_by_peer: dict[str, str] = {}
    attention_by_peer: dict[str, str] = {}
    state_pages_by_peer: dict[str, Any] = {}
    worker_statuses: list[dict[str, Any]] = []
    for peer in peers:
        status = _query_worker_status(peer, session_id)
        worker_statuses.append(status)
        shards = status.get("shards") if isinstance(status, dict) else []
        peer_runtime = "unknown"
        peer_attention = "unknown"
        peer_linear_ready = False
        if isinstance(shards, list):
            for shard in shards:
                if not isinstance(shard, dict) or shard.get("session_id") != session_id:
                    continue
                peer_runtime = str(shard.get("runtime_backend") or peer_runtime)
                peer_attention = str(shard.get("attention_backend") or peer_attention)
                peer_linear_ready = bool(shard.get("linear_attn_ready"))
                if shard.get("state_pages") is not None:
                    state_pages_by_peer[peer] = shard.get("state_pages")
                break
        runtime_by_peer[peer] = peer_runtime
        attention_by_peer[peer] = peer_attention
        linear_attn_ready = linear_attn_ready and peer_linear_ready
    pool_validation = _classify_runtime_pool(worker_statuses, session_id, pool_class)
    actual_pool_class = str(pool_validation.get("actual_pool_class") or pool_class)
    if actual_pool_class != pool_class:
        pool_fallback_reason = pool_validation.get("fallback_reason") or pool_fallback_reason or "runtime_status_mismatch"
    linear_attn_ready = bool(pool_validation.get("linear_attn_ready"))
    runtime_by_peer.update(pool_validation.get("runtime_backend_per_worker") or {})
    attention_by_peer.update(pool_validation.get("attention_backend_per_worker") or {})
    _register_pool(pool_id, {
        "actual_pool_class": actual_pool_class,
        "pool_validation": pool_validation,
        "pool_fallback_reason": pool_fallback_reason,
        "ready": bool(pool_validation.get("ready")),
    })

    # Tokeniser le prompt (adapté selon le modèle)
    model_type = model_config.get("model_type", "gpt2")
    if model_type == "gpt2":
        # GPT-2 : pas de chat template, prompt brut
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        formatted = f"Question: {prompt}\nRéponse:"
    else:
        system_msg = (
            "Tu es Vryx, un assistant IA concis. Réponds directement dans la langue de l'utilisateur. "
            "Ne montre pas de raisonnement interne et arrête-toi après la réponse."
        )
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": prompt},
        ]
        try:
            try:
                formatted = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
            except TypeError:
                formatted = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            formatted = f"{prompt}\n"

    input_ids = tokenizer.encode(formatted, return_tensors="pt")[0].tolist()
    eos_id = tokenizer.eos_token_id
    stop_ids = _stop_token_ids(tokenizer)
    routing_path = list(pool_info.get("routing_path") or peers)  # [w1, w2, w3]
    quic_probe = _quic_probe(routing_path, session_id, pool_id, hidden_transport)
    model_key = _model_fingerprint(model_config)
    prefix_cache_hit: dict[str, Any] = {
        "enabled": PREFIX_CACHE,
        "hit": False,
        "tokens_cached": 0,
        "cache_key": None,
        "load": None,
        "metadata_only": False,
        "fallback_reason": "disabled" if not PREFIX_CACHE else "miss",
    }
    if PREFIX_CACHE:
        for candidate in _prefix_candidates(input_ids, model_key):
            load_payload = {
                "session_id": session_id,
                "pool_id": pool_id,
                "prefix_hash": candidate.get("prefix_hash"),
                "tokens_cached": candidate.get("tokens_cached"),
                "model_fingerprint": model_key,
            }
            load_result = _cache_control(routing_path, "vryx.cache.load", load_payload)
            restored = all((r.get("data") or {}).get("cache_restored") for r in load_result.get("results", []))
            prefix_cache_hit = {
                "enabled": True,
                "hit": True,
                "tokens_cached": int(candidate.get("tokens_cached") or 0),
                "cache_key": candidate.get("prefix_hash"),
                "load": load_result,
                "metadata_only": not restored,
                "fallback_reason": None if restored else "cache_metadata_only",
            }
            break
    if PIPELINE_STREAM_MODE not in ("0", "false", "off", "legacy"):
        stream_open = _stream_control(routing_path, session_id, pool_id, "open", hidden_transport)

    print(f"[VPS] Inférence : {len(input_ids)} tokens prompt, {n} workers, routing={[p[:12] for p in routing_path]}, max_new_tokens={decode_cap}")

    generated_ids = []
    step_latencies = []
    batch_traces = []
    relay_metrics: list[dict[str, Any]] = []
    decode_modes: list[str] = []
    failure_error: Optional[str] = None
    t_infer = time.perf_counter()
    request_id = f"gen-{_now_ms()}-{threading.get_ident()}"
    batch_enabled = bool(CONTINUOUS_BATCHING and linear_attn_ready)

    # Payload initial : token_ids envoyés au premier worker
    prefill_decode_mode = "prefill_full_context"
    current_payload = {
        "session_id": session_id,
        "request_id": request_id,
        "token_ids": input_ids,
        "history_token_ids": input_ids,
        "step": 0,
        "seq_pos": 0,
        "decode_mode": prefill_decode_mode,
        "hidden_transport": hidden_transport,
        "pipeline_stream_mode": PIPELINE_STREAM_MODE,
        "use_kv_cache": WORKER_KV_CACHE,
        "stop_token_ids": stop_ids,
        "sampling": {
            "temperature": SAMPLING_TEMPERATURE,
            "top_p": SAMPLING_TOP_P,
            "top_k": SAMPLING_TOP_K,
            "repetition_penalty": REPETITION_PENALTY,
        },
        "hidden_quic": HIDDEN_QUIC,
        "prefix_cache_key": prefix_cache_hit.get("cache_key"),
        "prefix_cache_tokens": prefix_cache_hit.get("tokens_cached"),
        "speculative_heads": SPECULATIVE_HEADS,
    }

    current_dtype = "vryx.shard.pipeline"
    stop_reason: Optional[str] = None

    step = -1
    max_relay_iterations = decode_cap + 256
    while len(generated_ids) < decode_cap:
        step += 1
        if step > max_relay_iterations:
            stop_reason = stop_reason or "relay_iteration_guard"
            break
        t_step = time.perf_counter()
        result, batch_trace = _relay_pipeline_step(
            routing_path[0],
            current_dtype,
            current_payload,
            routing_path[1:],
            batch_enabled,
        )
        step_ms = int((time.perf_counter() - t_step) * 1000)
        step_latencies.append(step_ms)
        batch_traces.append(batch_trace)
        relay_metrics.append({
            "relay_ms": result.get("relay_ms"),
            "serialization_ms": result.get("serialization_ms"),
            "hidden_bytes": result.get("hidden_bytes"),
        })

        if not result.get("ok", True):
            err = result.get("error", "erreur inconnue")
            replacement_path = _failover_routing_path(routing_path, session_id, pool_info)
            if replacement_path and replacement_path != routing_path:
                print(f"[VPS] Failover hot : {routing_path[-1][:16]} → {replacement_path[-1][:16]}")
                routing_path = replacement_path
                result, batch_trace = _relay_pipeline_step(
                    routing_path[0],
                    current_dtype,
                    current_payload,
                    routing_path[1:],
                    batch_enabled,
                )
                batch_traces[-1] = batch_trace
                relay_metrics[-1] = {
                    "relay_ms": result.get("relay_ms"),
                    "serialization_ms": result.get("serialization_ms"),
                    "hidden_bytes": result.get("hidden_bytes"),
                }
                if result.get("ok", True):
                    err = ""
                else:
                    err = result.get("error", "erreur inconnue")
            if not result.get("ok", True):
                failure_error = f"Relais P2P étape {step} : {err}"
                print(f"[VPS] Step {step} failed : {err}")
                if (
                    not options.get("_hot_session_retry_done")
                    and not generated_ids
                    and _is_unknown_session_error(err)
                ):
                    model_key = _model_fingerprint(model_config)
                    cache_key = _SESSION_CACHE_KEY_VERSION + "|" + pool_class + "|" + model_key + "|" + "|".join(peers)
                    _invalidate_worker_session_cache(cache_key, pool_id, "relay_reported_unknown_session", session_id)
                    retry_options = dict(options)
                    retry_options["_hot_session_retry_done"] = True
                    print(f"[VPS] Relais signale session inconnue, recréation automatique ({session_id[:16]}…).")
                    return run_pipeline_chat(prompt, retry_options)
                break

        # Extraire la réponse du dernier worker (gRPC response encodée en data_b64)
        response: dict[str, Any] = {}
        relay_data_b64 = result.get("data_b64", "")
        if relay_data_b64:
            try:
                raw = base64.b64decode(relay_data_b64)
                response = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception as e:
                failure_error = f"Décodage réponse étape {step} : {e}"
                print(f"[VPS] Parse failed : {e}")
                break
        elif "data" in result and isinstance(result["data"], dict):
            inner = result["data"]
            if "data_b64" in inner:
                try:
                    raw = base64.b64decode(inner["data_b64"])
                    response = json.loads(raw.decode("utf-8", errors="replace"))
                except Exception:
                    pass

        if not isinstance(response, dict):
            failure_error = f"Réponse pipeline non JSON étape {step}"
            break

        if response.get("ok") is False:
            failure_error = response.get("error") or f"Worker étape {step} : exécution refusée"
            print(f"[VPS] Worker erreur : {failure_error}")
            if (
                not options.get("_hot_session_retry_done")
                and not generated_ids
                and _is_unknown_session_error(failure_error)
            ):
                model_key = _model_fingerprint(model_config)
                cache_key = _SESSION_CACHE_KEY_VERSION + "|" + pool_class + "|" + model_key + "|" + "|".join(peers)
                _invalidate_worker_session_cache(cache_key, pool_id, "worker_reported_unknown_session", session_id)
                retry_options = dict(options)
                retry_options["_hot_session_retry_done"] = True
                print(f"[VPS] Session hot inconnue côté worker, recréation automatique ({session_id[:16]}…).")
                return run_pipeline_chat(prompt, retry_options)
            break

        response_decode_mode = str(response.get("decode_mode") or ("prefill_full_context" if step == 0 else "unknown"))
        decode_modes.append(response_decode_mode)

        accepted_ids: list[int] = []
        cand = response.get("candidate_token_ids")
        ac_raw = response.get("accepted_token_count")
        dmicro = response.get("decode_microbatch") is True
        if isinstance(cand, list) and len(cand) > 0:
            try:
                ac = int(ac_raw) if isinstance(ac_raw, (int, float)) else len(cand)
            except (TypeError, ValueError, OverflowError):
                ac = len(cand)
            ac = max(0, min(ac, len(cand)))
            if dmicro or ac >= 2:
                accepted_ids = [int(x) for x in cand[:ac] if isinstance(x, (int, float))]
            elif SPECULATIVE_HEADS != "off" and ac > 0:
                accepted_ids = [int(x) for x in cand[:ac] if isinstance(x, (int, float))]

        next_token_id = response.get("next_token_id")
        if not accepted_ids:
            if next_token_id is None:
                failure_error = (
                    response.get("error")
                    or "Pas de next_token_id : le relais n'a pas atteint le worker tête LM ou "
                    "le premier hop n'est pas celui avec embedding (vérifier l'ordre stable des pairs)."
                )
                print(f"[VPS] Pas de next_token_id dans la réponse : {str(response)[:200]}")
                break
            emitted_ids = [int(next_token_id)]
        else:
            emitted_ids = accepted_ids[:]
            next_token_id = emitted_ids[-1]

        stop_idx = next((idx for idx, token_id in enumerate(emitted_ids) if token_id in stop_ids), None)
        if stop_idx is not None:
            generated_ids.extend(emitted_ids[:stop_idx])
            stop_reason = f"stop_token:{emitted_ids[stop_idx]}"
            break

        eos_pos = None
        if eos_id is not None:
            eos_pos = next((idx for idx, token_id in enumerate(emitted_ids) if token_id == eos_id), None)
        if eos_pos is not None:
            generated_ids.extend(emitted_ids[: eos_pos + 1])
            stop_reason = f"eos:{eos_id}"
            break

        generated_ids.extend(emitted_ids)
        if len(generated_ids) >= decode_cap:
            generated_ids = generated_ids[:decode_cap]
            break

        partial_text = _decode_generated_token_ids(tokenizer, generated_ids)
        if _detect_repetition_loop(partial_text):
            stop_reason = "repetition_guard"
            break
        if len(generated_ids) >= 12 and any(partial_text.rstrip().endswith(mark) for mark in (".", "!", "?")):
            stop_reason = "sentence_boundary"
            break

        # Micro-décodage : plusieurs pas sur le même worker pour réduire les allers-retours relais WAN.
        all_ids = input_ids + generated_ids
        stateful_decode = bool(WORKER_KV_CACHE and generated_ids)
        if stateful_decode:
            next_input_ids = [generated_ids[-1]]
            next_seq_pos = len(all_ids) - 1
            next_decode_mode = "single_token_stateful"
        else:
            next_input_ids = all_ids
            next_seq_pos = 0
            next_decode_mode = "full_context_fallback"
        next_step_val = step + 1
        remaining_gen = max(0, decode_cap - len(generated_ids))
        micro_budget = 1
        if (
            DECODE_MICROBATCH
            and len(routing_path) == 1
            and WORKER_KV_CACHE
            and stateful_decode
            and remaining_gen > 1
            and float(SAMPLING_TEMPERATURE) <= 1e-9
            and next_step_val >= 1
        ):
            micro_budget = max(2, min(DECODE_MICROBATCH_CAP, remaining_gen))

        current_payload = {
            "session_id": session_id,
            "request_id": request_id,
            "token_ids": next_input_ids,
            "history_token_ids": all_ids,
            "step": next_step_val,
            "micro_decode_budget": micro_budget if next_step_val >= 1 else 1,
            "seq_pos": next_seq_pos,
            "decode_mode": next_decode_mode,
            "hidden_transport": hidden_transport,
            "pipeline_stream_mode": PIPELINE_STREAM_MODE,
            "use_kv_cache": WORKER_KV_CACHE,
            "stateful_required": stateful_decode,
            "stop_token_ids": stop_ids,
            "sampling": {
                "temperature": SAMPLING_TEMPERATURE,
                "top_p": SAMPLING_TOP_P,
                "top_k": SAMPLING_TOP_K,
                "repetition_penalty": REPETITION_PENALTY,
            },
            "hidden_quic": HIDDEN_QUIC,
            "prefix_cache_key": prefix_cache_hit.get("cache_key"),
            "prefix_cache_tokens": prefix_cache_hit.get("tokens_cached"),
            "speculative_heads": SPECULATIVE_HEADS,
        }
        current_dtype = "vryx.shard.pipeline"

    total_ms = int((time.perf_counter() - t_infer) * 1000)
    stream_close = {"ok": False, "results": []}
    if stream_open.get("ok"):
        stream_close = _stream_control(routing_path, session_id, pool_id, "close", hidden_transport)
    prefix_cache_save = {"enabled": PREFIX_CACHE, "saved": False, "results": []}
    if PREFIX_CACHE and len(input_ids) >= PREFIX_CACHE_MIN_TOKENS and generated_ids:
        cache_key = _prefix_hash(input_ids, model_key)
        save_payload = {
            "session_id": session_id,
            "pool_id": pool_id,
            "prefix_hash": cache_key,
            "tokens_cached": len(input_ids),
            "model_fingerprint": model_key,
            "routing_path": routing_path,
            "ttl_sec": PREFIX_CACHE_TTL_SEC,
        }
        save_result = _cache_control(routing_path, "vryx.cache.save", save_payload)
        manifest = {
            **save_payload,
            "model_id": MODEL_ID,
            "created_at_ms": _now_ms(),
            "worker_results": save_result.get("results", []),
        }
        _write_prefix_cache_manifest(model_key, manifest)
        prefix_cache_save = {"enabled": True, "saved": save_result.get("ok", False), "manifest": manifest, "results": save_result.get("results", [])}
    response_text = _decode_generated_token_ids(tokenizer, generated_ids)
    avg_ms = int(sum(step_latencies) / len(step_latencies)) if step_latencies else 0
    relay_ms_total = sum(int(m.get("relay_ms") or 0) for m in relay_metrics)
    serialization_ms_total = sum(int(m.get("serialization_ms") or 0) for m in relay_metrics)
    hidden_bytes_total = sum(int(m.get("hidden_bytes") or 0) for m in relay_metrics)
    max_batch_size_seen = max((int(t.get("batch_size") or 1) for t in batch_traces), default=1)
    avg_queue_wait_ms = int(sum(int(t.get("queue_wait_ms") or 0) for t in batch_traces) / len(batch_traces)) if batch_traces else 0
    decode_batch_ms_total = sum(int(t.get("decode_batch_ms") or 0) for t in batch_traces)
    max_active_sessions = max((int(t.get("active_sessions") or 1) for t in batch_traces), default=1)
    avg_batch_efficiency = round(
        sum(float(t.get("batch_efficiency_pct") or 0) for t in batch_traces) / len(batch_traces),
        2,
    ) if batch_traces else (100.0 if max_batch_size_seen > 1 else round((1 / BATCH_MAX_SIZE) * 100, 2))

    print(f"[VPS] {len(generated_ids)} tokens en {total_ms}ms ({avg_ms}ms/tok)")
    post_prefill_modes = [m for m in decode_modes if m != "prefill_full_context"]
    effective_decode_mode = (
        "single_token_stateful"
        if post_prefill_modes and all(m == "single_token_stateful" for m in post_prefill_modes)
        else ("prefill_only" if not post_prefill_modes else "full_context_fallback")
    )

    base_trace: dict[str, Any] = {
        "layout": "pipeline_relay_daisy_chain",
        "routing_path": routing_path,
        "peers": routing_path,
        "session_id": session_id,
        "pool_id": pool_info.get("pool_id"),
        "pool_class": actual_pool_class,
        "requested_pool_class": pool_info.get("pool_class") or pool_class,
        "actual_pool_class": actual_pool_class,
        "pool_validation": pool_validation,
        "pool_preference": pool_preference,
        "pool_fallback_reason": pool_fallback_reason,
        "pool_status": pool_info.get("status"),
        "shard_init_tuning": {
            "ready_poll_fast_sec": _SHARD_READY_POLL_FAST,
            "ready_poll_slow_sec": _SHARD_READY_POLL_SLOW,
            "ready_poll_slow_after_iterations": _SHARD_READY_POLL_SLOW_AFTER,
            "parallel_shard_init": PARALLEL_SHARD_INIT,
            "parallel_shard_init_max": PARALLEL_SHARD_INIT_MAX if PARALLEL_SHARD_INIT else 1,
        },
        "assignments": pool_info.get("assignments") or [],
        "replicas": pool_info.get("replicas") or [],
        "peer_latency_matrix": pool_info.get("peer_latency_matrix") or {},
        "hidden_transport": hidden_transport,
        "requested_quantization": requested_quantization,
        "effective_quantization": hidden_transport,
        "quantization_fallback_reason": quantization_fallback_reason,
        "pipeline_stream_mode": PIPELINE_STREAM_MODE,
        "decode_mode": effective_decode_mode,
        "decode_modes": decode_modes,
        "stream_open": stream_open,
        "stream_close": stream_close,
        "stream_fallback": "persistent_request_response" if PERSISTENT_RELAY else "request_response",
        "persistent_relay": PERSISTENT_RELAY,
        "connection_reuse": PERSISTENT_RELAY,
        "relay_timeout_sec": TIMEOUT,
        "pipeline_step_timeout_sec": PIPELINE_STEP_TIMEOUT,
        "relay_ms": relay_ms_total,
        "serialization_ms": serialization_ms_total,
        "hidden_bytes": hidden_bytes_total,
        "worker_kv_cache": WORKER_KV_CACHE,
        "generation_control": {
            "stop_token_ids": stop_ids,
            "stop_reason": stop_reason,
            "temperature": SAMPLING_TEMPERATURE,
            "top_p": SAMPLING_TOP_P,
            "top_k": SAMPLING_TOP_K,
            "repetition_penalty": REPETITION_PENALTY,
            "repetition_guard": REPETITION_GUARD,
        },
        "quic_enabled": HIDDEN_QUIC,
        "quic_used": bool(quic_probe.get("quic_used")),
        "quic_probe": quic_probe,
        "quic_available": bool(quic_probe.get("quic_available")),
        "quic_fallback_reason": quic_probe.get("fallback_reason") or ("disabled" if not HIDDEN_QUIC else None),
        "prefix_cache": {
            "enabled": PREFIX_CACHE,
            "hit": bool(prefix_cache_hit.get("hit")),
            "tokens": int(prefix_cache_hit.get("tokens_cached") or 0),
            "metadata_only": bool(prefix_cache_hit.get("metadata_only")),
            "load": prefix_cache_hit.get("load"),
            "save": prefix_cache_save,
            "fallback_reason": prefix_cache_hit.get("fallback_reason"),
        },
        "engine_features": {
            "speculative_heads": SPECULATIVE_HEADS,
            "speculative_available": False,
            "speculative_fallback_reason": "heads_not_loaded" if SPECULATIVE_HEADS != "off" else "disabled",
            "continuous_batching": CONTINUOUS_BATCHING,
            "continuous_batching_mode": "linear_attn_ready" if (CONTINUOUS_BATCHING and linear_attn_ready) else "single_request_fallback",
            "pipeline_overlap": PIPELINE_OVERLAP,
            "pipeline_overlap_mode": "persistent_double_buffer_trace" if PIPELINE_OVERLAP else "disabled",
            "persistent_relay": PERSISTENT_RELAY,
            "chunked_prefill": CHUNKED_PREFILL,
            "prefill_chunk_tokens": PREFILL_CHUNK_TOKENS,
            "ring_attention": RING_ATTENTION,
            "ring_attention_mode": "design_flag_only",
        },
        "steps": [
            {"peer": routing_path[min(i, n - 1)], "rank": i, "role": "pipeline_layer_forward",
             "latency_ms": ms,
             "relay_ms": (relay_metrics[i] if i < len(relay_metrics) else {}).get("relay_ms"),
             "serialization_ms": (relay_metrics[i] if i < len(relay_metrics) else {}).get("serialization_ms"),
             "hidden_bytes": (relay_metrics[i] if i < len(relay_metrics) else {}).get("hidden_bytes")}
            for i, ms in enumerate(step_latencies[:len(routing_path)])
        ],
        "compute_time_ms": total_ms,
        "runtime_backend_per_worker": {
            assignment.get("peer"): runtime_by_peer.get(assignment.get("peer")) or assignment.get("runtime_backend") or _runtime_for_pool(actual_pool_class)
            for assignment in (pool_info.get("assignments") or [])
            if isinstance(assignment, dict)
        },
        "weight_quantization_per_worker": {
            assignment.get("peer"): assignment.get("weight_quantization") or os.environ.get("VRYX_WEIGHT_QUANTIZATION", "fp16")
            for assignment in (pool_info.get("assignments") or [])
            if isinstance(assignment, dict)
        },
        "attention_backend_per_worker": {
            assignment.get("peer"): attention_by_peer.get(assignment.get("peer")) or assignment.get("attention_backend") or _attention_for_pool(actual_pool_class)
            for assignment in (pool_info.get("assignments") or [])
            if isinstance(assignment, dict)
        },
        "batching": {
            "enabled": batch_enabled,
            "batch_size": max_batch_size_seen,
            "queue_wait_ms": avg_queue_wait_ms,
            "decode_batch_ms": decode_batch_ms_total or total_ms,
            "active_sessions": max_active_sessions,
            "batch_efficiency_pct": avg_batch_efficiency,
            "max_batch_size": BATCH_MAX_SIZE,
            "window_ms": BATCH_WINDOW_MS,
            "steps": batch_traces,
            "linear_attn_ready": linear_attn_ready,
        },
        "state_pages_per_worker": state_pages_by_peer,
        "overlap": {
            "enabled": PIPELINE_OVERLAP and PERSISTENT_RELAY,
            "compute_overlap_pct": 0,
            "network_hidden_ms": relay_ms_total if (PIPELINE_OVERLAP and PERSISTENT_RELAY) else None,
            "serialization_ms": serialization_ms_total,
            "hidden_bytes": hidden_bytes_total,
            "mode": "persistent_double_buffer_scaffold" if (PIPELINE_OVERLAP and PERSISTENT_RELAY) else "disabled",
            "linear_attn_ready": linear_attn_ready,
            "connection_reuse": PERSISTENT_RELAY,
        },
        "tokens_generated": len(generated_ids),
        "avg_ms_per_token": avg_ms,
        "hot_path_tps": round((len(generated_ids) * 1000.0 / total_ms), 3) if total_ms > 0 else 0,
        "setup_ms": setup_ms,
        "benchmark": {
            "target_tps": 15,
            "target_ms_per_token": 66,
            "intermediate_target_ms_per_token": 250,
            "actual_ms_per_token": avg_ms,
            "actual_tps": round((len(generated_ids) * 1000.0 / total_ms), 3) if total_ms > 0 else 0,
            "decode_mode": effective_decode_mode,
            "routing_hops": len(routing_path),
            "stream_session_hot": bool(stream_open.get("ok")),
            "resident_pool": pool_info.get("status") in ("hot", "warming"),
            "hidden_transport": hidden_transport,
            "requested_quantization": requested_quantization,
            "effective_quantization": hidden_transport,
            "quantization_fallback_reason": quantization_fallback_reason,
            "kv_cache_requested": WORKER_KV_CACHE,
            "quic_enabled": HIDDEN_QUIC,
            "quic_used": bool(quic_probe.get("quic_used")),
            "persistent_relay": PERSISTENT_RELAY,
            "relay_ms": relay_ms_total,
            "serialization_ms": serialization_ms_total,
            "hidden_bytes": hidden_bytes_total,
            "prefix_cache_hit": bool(prefix_cache_hit.get("hit")),
            "prefix_cache_tokens": int(prefix_cache_hit.get("tokens_cached") or 0),
            "continuous_batching": CONTINUOUS_BATCHING,
            "chunked_prefill": CHUNKED_PREFILL,
            "ring_attention": RING_ATTENTION,
            "pipeline_step_timeout_sec": PIPELINE_STEP_TIMEOUT,
        },
        "metrics": {
            "prompt_tokens": len(input_ids),
            "completion_tokens": len(generated_ids),
            "total_tokens": len(input_ids) + len(generated_ids),
            "vps_delegate_ms": 0,
            "decode_mode": effective_decode_mode,
            "actual_pool_class": actual_pool_class,
            "relay_ms": relay_ms_total,
            "serialization_ms": serialization_ms_total,
            "hidden_bytes": hidden_bytes_total,
            "persistent_relay": PERSISTENT_RELAY,
        },
    }

    if failure_error and generated_ids:
        base_trace["ok"] = True
        base_trace["warning"] = failure_error
        base_trace["partial"] = True
        return {
            "ok": True,
            "text": response_text,
            "trace": base_trace,
            "metrics": {
                "prompt_tokens": len(input_ids),
                "completion_tokens": len(generated_ids),
                "total_tokens": len(input_ids) + len(generated_ids),
                "vps_delegate_ms": 0,
            },
        }

    if failure_error:
        base_trace["ok"] = False
        base_trace["error"] = failure_error
        return {
            "ok": False,
            "text": "",
            "error": failure_error,
            "trace": base_trace,
            "metrics": {
                "prompt_tokens": len(input_ids),
                "completion_tokens": len(generated_ids),
                "total_tokens": len(input_ids) + len(generated_ids),
                "vps_delegate_ms": 0,
            },
        }

    if not generated_ids:
        err = "Aucun jeton généré : pipeline interrompu avant le premier jeton."
        base_trace["ok"] = False
        base_trace["error"] = err
        return {
            "ok": False,
            "text": "",
            "error": err,
            "trace": base_trace,
            "metrics": {
                "prompt_tokens": len(input_ids),
                "completion_tokens": 0,
                "total_tokens": len(input_ids),
                "vps_delegate_ms": 0,
            },
        }

    base_trace["ok"] = True
    return {
        "ok": True,
        "text": response_text,
        "trace": base_trace,
        "metrics": {
            "prompt_tokens": len(input_ids),
            "completion_tokens": len(generated_ids),
            "total_tokens": len(input_ids) + len(generated_ids),
            "vps_delegate_ms": 0,
        },
    }


def maybe_run_worker_only_chat(prompt: str, options: Optional[dict[str, Any]] = None) -> dict:
    """Point d'entrée depuis inference_server.py."""
    peers = _discover_live_peers()
    if not peers:
        return {
            "ok": False,
            "text": "",
            "error": (
                "Aucun pair worker joignable depuis le stage1 (liste vide après découverte). "
                "Vérifier `/api/internal/live-peers`, les heartbeats `/api/workers/status` "
                "et la reconnexion P2P bootstrap des workers après redémarrage initiateur."
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": [],
                "peers": [],
                "failure_stage": "discover_live_peers_empty",
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }

    result = run_pipeline_chat(prompt, options)
    if result is None:
        return {
            "ok": False,
            "text": "",
            "error": "Orchestre pipeline : aucun résultat (abort interne). Consulter les logs stage1.",
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": sorted(peers),
                "peers": sorted(peers),
                "failure_stage": "run_pipeline_chat_none",
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }

    if result.get("trace") and result["trace"].get("layout") != "mlx_lm_direct_p2p":
        result["trace"]["layout"] = "pipeline_relay_daisy_chain"
    return result
