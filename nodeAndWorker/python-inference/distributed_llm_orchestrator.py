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
  VRYX_DIST_MAX_TOKENS     Tokens max générés (défaut : 32768)
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
  HF_TOKEN                     Token Hugging Face (si vide, utilise HF_TOKEN_FILE)
  HF_TOKEN_FILE                Fichier token HF (par défaut {HF_HOME}/token)
  HF_HOME                      Répertoire HF (par défaut ~/.cache/huggingface)
  HF_HUB_CACHE                 Répertoire HF hub cache explicite
  HF_REVISION                  Révision HF (défaut « main »)
  HF_DOWNLOAD_MAX_WORKERS      Concurrence de téléchargement HF (défaut 8)
  HF_DOWNLOAD_ALLOW_PATTERNS   Liste CSV de patterns de snapshot à télécharger

"""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional
from urllib.parse import quote, urlparse

import urllib.error
import urllib.request

import numpy as np

from batching import BatchQueue, batching_trace

# ── Config ─────────────────────────────────────────────────────────────────────

MODEL_ID_DEFAULT = os.environ.get("VRYX_DIST_MODEL", "Qwen/Qwen3.5-9B")
MODEL_ID = MODEL_ID_DEFAULT
try:
    MAX_NEW_TOKENS = int(os.environ.get("VRYX_DIST_MAX_TOKENS", "32768"))
except (TypeError, ValueError):
    MAX_NEW_TOKENS = 32768
MAX_NEW_TOKENS = max(1, min(32768, MAX_NEW_TOKENS))
HF_HOME = os.path.expanduser(os.environ.get("HF_HOME", "~/.cache/huggingface").strip() or "~/.cache/huggingface")
HF_HUB_CACHE = os.environ.get("HF_HUB_CACHE", "").strip()
HF_TOKEN_FILE = os.environ.get("HF_TOKEN_FILE", os.path.join(HF_HOME, "token")).strip()
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
HF_REVISION = os.environ.get("HF_REVISION", None)
MODEL_SNAPSHOT_DIR = os.environ.get("VRYX_MODEL_SNAPSHOT_DIR", "").strip()
MODEL_LOCAL_ONLY = os.environ.get("VRYX_MODEL_LOCAL_ONLY", "0").strip().lower() in ("1", "true", "yes", "on")
HF_DOWNLOAD_MAX_WORKERS = max(1, min(32, int(os.environ.get("HF_DOWNLOAD_MAX_WORKERS", "8") or 8)))
HF_DOWNLOAD_ALLOW_PATTERNS = [
    p.strip()
    for p in os.environ.get(
        "HF_DOWNLOAD_ALLOW_PATTERNS",
        "*.json,*.safetensors,tokenizer*,*.model,*.tiktoken,merges.txt,vocab.*,special_tokens_map.json,generation_config.json",
    ).split(",")
    if p.strip()
]
RELAY_URL = os.environ.get("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031").rstrip("/")
DECODE_MICROBATCH = os.environ.get("VRYX_DECODE_MICROBATCH", "1").strip().lower() not in ("0", "false", "no", "off")
try:
    DECODE_MICROBATCH_CAP = max(2, min(64, int(os.environ.get("VRYX_DECODE_MICROBATCH_CAP", "32") or "32")))
except (TypeError, ValueError):
    DECODE_MICROBATCH_CAP = 32
MLX_LM_DIRECT = os.environ.get("VRYX_MLX_LM_DIRECT", "0").strip().lower() in ("1", "true", "yes", "on")
LLAMA_CPP_DIRECT = os.environ.get("VRYX_LLAMA_CPP_DIRECT", "0").strip().lower() in ("1", "true", "yes", "on")

RELAY_TLS = threading.local()


def _emit_stream_callback_async(
    callback_url: str,
    stream_id: str,
    stream_secret: str,
    event: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    if not callback_url or not stream_id or not stream_secret or not event:
        return

    body_obj = {"stream_id": stream_id, "event": event}
    if isinstance(payload, dict) and payload:
        body_obj.update(payload)
    body = json.dumps(body_obj, ensure_ascii=False).encode("utf-8")

    def _post() -> None:
        try:
            req = urllib.request.Request(
                callback_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {stream_secret}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=0.6) as resp:
                resp.read(128)
        except Exception:
            pass

    threading.Thread(target=_post, daemon=True).start()


def _resolve_hf_token() -> tuple[Optional[str], str]:
    """Résout le token Hugging Face depuis HF_TOKEN puis HF_TOKEN_FILE.

    Returns:
        (token, source): token vide -> None; source : "HF_TOKEN", "HF_TOKEN_FILE" ou "none".
    """
    if HF_TOKEN:
        token = HF_TOKEN.strip()
        if token:
            return token, "HF_TOKEN"

    token_path = os.path.expanduser(HF_TOKEN_FILE)
    if token_path and os.path.isfile(token_path):
        try:
            with open(token_path, "r", encoding="utf-8") as fp:
                line = fp.readline().strip()
            if line:
                return line, "HF_TOKEN_FILE"
        except Exception as exc:
            print(f"[VPS] impossible de lire HF_TOKEN_FILE={token_path!r} : {exc}")
    return None, "none"


def _prepare_hf_cache_env() -> None:
    """Assure un cache HF prévisible et crée les dossiers si nécessaire."""
    if HF_HOME:
        os.environ["HF_HOME"] = HF_HOME
        try:
            os.makedirs(HF_HOME, exist_ok=True)
        except Exception:
            pass

    if HF_HUB_CACHE:
        os.environ["HF_HUB_CACHE"] = HF_HUB_CACHE
        try:
            os.makedirs(HF_HUB_CACHE, exist_ok=True)
        except Exception:
            pass


def _hf_snapshot_download_kwargs(token: Optional[str]) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "allow_patterns": HF_DOWNLOAD_ALLOW_PATTERNS,
        "max_workers": HF_DOWNLOAD_MAX_WORKERS,
        "resume_download": True,
        "local_dir_use_symlinks": False,
        "token": token,
    }
    if HF_REVISION:
        kwargs["revision"] = HF_REVISION.strip()
    if HF_HUB_CACHE:
        kwargs["cache_dir"] = HF_HUB_CACHE
    if not kwargs["allow_patterns"]:
        kwargs.pop("allow_patterns", None)
    return kwargs


def _hf_download_error_hint(exc: BaseException) -> str:
    """Retourne une recommandation lisible en cas d'échec de snapshot_download."""
    msg = str(exc).lower()
    if "gated repo" in msg or "not in the authorized list" in msg:
        return (
            "Ce modèle est gated: vérifie que ton token HF est valide, actif et a bien accès "
            f"au repo {MODEL_ID!r}."
            " Sans ça, l'accès retourne 403/401."
        )
    try:
        import huggingface_hub.errors as hf_errors
    except Exception:
        return str(exc)

    # Note: on s'adapte aux variantes de versions HF.
    if isinstance(exc, getattr(hf_errors, "GatedRepoError", tuple())):
        return (
            "Ce modèle est gated: vérifie que ton token HF est valide, actif et a bien accès "
            f"au repo {MODEL_ID!r}."
            " Sans ça, l'accès retourne 403."
        )
    if isinstance(exc, getattr(hf_errors, "RepositoryNotFoundError", tuple())):
        return (
            "Le repo Hugging Face est introuvable (id invalide ou privé). "
            f"Check MODEL_ID={MODEL_ID!r}."
        )
    if isinstance(exc, getattr(hf_errors, "EntryNotFoundError", tuple())):
        return (
            f"Aucun fichier ne correspond aux motifs autorisés (patterns={HF_DOWNLOAD_ALLOW_PATTERNS}). "
            "Réduis la liste de patterns si nécessaire."
        )
    if isinstance(exc, getattr(hf_errors, "HTTPError", tuple())):
        msg = str(exc)
        if "401" in msg:
            return (
                "Authentification refusée (401). Utilise un token Hugging Face valide "
                "(HF_TOKEN ou HF_TOKEN_FILE)."
            )
        if "403" in msg:
            return (
                f"Accès refusé (403) pour {MODEL_ID!r}. Modèle gated ou IP interdite "
                "(vérifie le token + autorisation repo)."
            )
        if "404" in msg:
            return f"Ressource introuvable (404) pour {MODEL_ID!r}."
        return f"Erreur HTTP HF: {msg}"
    return str(exc)


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

def _env_bool(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")

DIST_WAIT_FOR_MIN_WORKERS = _env_bool("VRYX_DIST_WAIT_FOR_MIN_WORKERS", "0")
try:
    DIST_WAIT_FOR_MIN_WORKERS_TIMEOUT_SEC = max(
        0.0,
        float(os.environ.get("VRYX_DIST_WAIT_FOR_MIN_WORKERS_TIMEOUT_SEC", "120") or 120),
    )
except (TypeError, ValueError):
    DIST_WAIT_FOR_MIN_WORKERS_TIMEOUT_SEC = 120.0
try:
    DIST_WAIT_FOR_MIN_WORKERS_POLL_SEC = max(
        0.1,
        float(os.environ.get("VRYX_DIST_WAIT_FOR_MIN_WORKERS_POLL_SEC", "2.0") or 2.0),
    )
except (TypeError, ValueError):
    DIST_WAIT_FOR_MIN_WORKERS_POLL_SEC = 2.0
try:
    ADMIN_STREAM_WORKER_WAIT_SEC = max(
        0.0,
        float(os.environ.get("VRYX_ADMIN_STREAM_WORKER_WAIT_SEC", "8") or 8),
    )
except (TypeError, ValueError):
    ADMIN_STREAM_WORKER_WAIT_SEC = 8.0
try:
    DIST_MIN_SHARDED_WORKERS = int(os.environ.get("VRYX_DIST_MIN_SHARDED_WORKERS", "2") or 2)
except (TypeError, ValueError):
    DIST_MIN_SHARDED_WORKERS = 2
ALLOW_SINGLE_WORKER_LARGE_LLAMA = _env_bool("VRYX_ALLOW_SINGLE_WORKER_LARGE_LLAMA", "0")
ALLOW_EXPERIMENTAL_LLAMA70B_DIRECT = _env_bool("VRYX_ALLOW_EXPERIMENTAL_LLAMA70B_DIRECT", "0")
try:
    DIST_CONTEXT_SAFETY_TOKENS = int(os.environ.get("VRYX_DIST_CONTEXT_SAFETY_TOKENS", "16") or 16)
except (TypeError, ValueError):
    DIST_CONTEXT_SAFETY_TOKENS = 16
try:
    LLAMA70B_Q4_MIN_WORKING_SET_MB = max(
        40960.0,
        float(os.environ.get("VRYX_LLAMA70B_Q4_MIN_WORKING_SET_MB", "57344") or 57344),
    )
except (TypeError, ValueError):
    LLAMA70B_Q4_MIN_WORKING_SET_MB = 57344.0


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


def _routing_pipeline_width(peers_online: int, min_workers: int = 1) -> int:
    """Nombre maximal de peers embarqués pour couvrir num_hidden_layers_total (avec plafonds)."""
    peers_online = max(0, int(peers_online))
    min_workers = max(1, int(min_workers))
    if peers_online < min_workers:
        return peers_online
    use_all = os.environ.get("VRYX_DIST_USE_ALL_COMPATIBLE_PEERS", "").strip().lower() in ("1", "true", "yes")
    if use_all:
        try:
            cap = int(float(os.environ.get("VRYX_DIST_HARD_CAP_PEERS", "48") or 48))
        except (TypeError, ValueError):
            cap = 48
        cap = max(cap, min_workers)
        width = min(peers_online, cap)
        print(f"[VPS] Daisy Chain largeur dynamique USE_ALL_COMPATIBLE_PEERS → {width} peer(s) (cap={cap}, en ligne={peers_online})")
        return width
    return max(min_workers, min(peers_online, MAX_WORKERS))


def _timeout_sec(name: str, default: float, floor: float = 1.0) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None else float(default)
    except (TypeError, ValueError):
        value = float(default)
    return max(value, floor)


TIMEOUT = _timeout_sec("VRYX_DIST_TIMEOUT_SEC", 600.0)
PIPELINE_STEP_TIMEOUT = _timeout_sec("VRYX_PIPELINE_STEP_TIMEOUT_SEC", max(TIMEOUT, 600.0))
SHARD_INIT_TIMEOUT = _timeout_sec("VRYX_SHARD_INIT_TIMEOUT_SEC", 600.0)
SHARD_LOAD_TIMEOUT = _timeout_sec("VRYX_SHARD_LOAD_TIMEOUT_SEC", 600.0)
SHARD_BUILD_TIMEOUT = _timeout_sec("VRYX_SHARD_BUILD_TIMEOUT_SEC", 600.0)
SHARD_READY_TIMEOUT = _timeout_sec("VRYX_SHARD_READY_TIMEOUT_SEC", min(180.0, SHARD_BUILD_TIMEOUT), floor=5.0)
SHARD_STATUS_TIMEOUT = _timeout_sec("VRYX_SHARD_STATUS_TIMEOUT_SEC", 120.0, floor=20.0)
MLX_DIRECT_RELAY_TIMEOUT = _timeout_sec("VRYX_MLX_DIRECT_RELAY_TIMEOUT_SEC", 30.0, floor=5.0)
SHARD_TTL = int(os.environ.get("VRYX_DIST_SHARD_TTL", "1800"))
POOL_TTL = int(os.environ.get("VRYX_POOL_TTL_SEC", str(max(SHARD_TTL, 24 * 3600))))
KEEP_POOL_SHARDS = os.environ.get("VRYX_POOL_KEEP_SHARDS", "true").lower() not in ("0", "false", "no")
POOL_REPLICATION_FACTOR = max(0, int(os.environ.get("VRYX_POOL_REPLICATION_FACTOR", "1")))
SHARD_BASE_DIR = os.environ.get("VRYX_SHARD_BASE_DIR", "/var/lib/vryx-shards")
try:
    SHARD_MIN_FREE_MB = max(0, int(os.environ.get("VRYX_MIN_SHARD_FREE_MB", "10240")))
except (TypeError, ValueError):
    SHARD_MIN_FREE_MB = 10240
# WAN / relais : 25 ms exclut la plupart des workers domicile → défaut plus large (override possible).
HOT_POOL_MAX_RTT_MS = float(os.environ.get("VRYX_HOT_POOL_MAX_RTT_MS", "2000"))
HOT_POOL_IDEAL_RTT_MS = float(os.environ.get("VRYX_HOT_POOL_IDEAL_RTT_MS", "80"))
MICROBATCH_RTT_TARGET_MS = float(os.environ.get("VRYX_MICROBATCH_RTT_TARGET_MS", "180"))
HIDDEN_TRANSPORT = os.environ.get("VRYX_HIDDEN_TRANSPORT", "int8").lower()
PIPELINE_STREAM_MODE = os.environ.get("VRYX_PIPELINE_STREAM_MODE", "hot_session").lower()
WORKER_KV_CACHE = os.environ.get("VRYX_WORKER_KV_CACHE", "true").lower() not in ("0", "false", "no")
SAMPLING_TEMPERATURE = float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0"))
SAMPLING_TOP_P = float(os.environ.get("VRYX_SAMPLING_TOP_P", "0.65"))
SAMPLING_TOP_K = int(os.environ.get("VRYX_SAMPLING_TOP_K", "20"))
REPETITION_PENALTY = float(os.environ.get("VRYX_REPETITION_PENALTY", "1.08"))
REPETITION_GUARD = os.environ.get("VRYX_REPETITION_GUARD", "true").lower() not in ("0", "false", "no")
HIDDEN_QUIC = os.environ.get("VRYX_HIDDEN_QUIC", "0").lower() in ("1", "true", "yes")
PREFIX_CACHE = os.environ.get("VRYX_PREFIX_CACHE", "1").lower() not in ("0", "false", "no")
PREFIX_CACHE_TTL_SEC = int(os.environ.get("VRYX_PREFIX_CACHE_TTL_SEC", str(24 * 3600)))
PREFIX_CACHE_MIN_TOKENS = int(os.environ.get("VRYX_PREFIX_CACHE_MIN_TOKENS", "32"))
PREFIX_CACHE_DIR = os.environ.get("VRYX_PREFIX_CACHE_DIR", os.path.join(SHARD_BASE_DIR, "prefix-cache"))
SHARD_TRANSFER_MODE = os.environ.get("VRYX_SHARD_TRANSFER_MODE", "range").strip().lower()
GGUF_PREPARED_SESSION = os.environ.get("VRYX_GGUF_PREPARED_SESSION", "").strip()
GGUF_PREPARED_SESSION_DIR = os.environ.get("VRYX_GGUF_PREPARED_SESSION_DIR", "").strip()
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
_mlx_lm_direct_lock = threading.Lock()
_mlx_lm_direct_leases: dict[str, float] = {}
_mlx_lm_peer_busy_until: dict[str, float] = {}
_mlx_lm_peer_next_index = 0


def _prune_mlx_direct_leases(now: float | None = None) -> None:
    now = time.time() if now is None else now
    for peer, until in list(_mlx_lm_direct_leases.items()):
        if until <= now:
            _mlx_lm_direct_leases.pop(peer, None)
    for peer, until in list(_mlx_lm_peer_busy_until.items()):
        if until <= now:
            _mlx_lm_peer_busy_until.pop(peer, None)


def _try_acquire_mlx_direct_peer(peer: str, lease_sec: float) -> tuple[bool, str, int]:
    now = time.time()
    with _mlx_lm_direct_lock:
        _prune_mlx_direct_leases(now)
        busy_until = float(_mlx_lm_peer_busy_until.get(peer) or 0.0)
        if busy_until > now:
            return False, "worker_busy", int(max(1, (busy_until - now) * 1000))
        leased_until = float(_mlx_lm_direct_leases.get(peer) or 0.0)
        if leased_until > now:
            return False, "worker_leased", int(max(1, (leased_until - now) * 1000))
        _mlx_lm_direct_leases[peer] = now + max(5.0, lease_sec)
        return True, "leased", 0


def _release_mlx_direct_peer(peer: str) -> None:
    with _mlx_lm_direct_lock:
        _mlx_lm_direct_leases.pop(peer, None)


def _mark_mlx_direct_peer_busy(peer: str, busy_sec: float = 12.0) -> None:
    with _mlx_lm_direct_lock:
        _mlx_lm_peer_busy_until[peer] = time.time() + max(2.0, busy_sec)
        _mlx_lm_direct_leases.pop(peer, None)


def _mlx_direct_ready_peers(peers: list[str]) -> tuple[list[str], int]:
    now = time.time()
    ready: list[str] = []
    retry_after_ms = 0
    with _mlx_lm_direct_lock:
        _prune_mlx_direct_leases(now)
        for peer in peers:
            blocked_until = max(
                float(_mlx_lm_direct_leases.get(peer) or 0.0),
                float(_mlx_lm_peer_busy_until.get(peer) or 0.0),
            )
            if blocked_until > now:
                retry_after_ms = max(retry_after_ms, int((blocked_until - now) * 1000))
                continue
            ready.append(peer)
    return ready, retry_after_ms


def _rotate_direct_ready_peers(peers: list[str]) -> list[str]:
    global _mlx_lm_peer_next_index
    if len(peers) <= 1:
        return peers
    with _mlx_lm_direct_lock:
        offset = _mlx_lm_peer_next_index % len(peers)
        _mlx_lm_peer_next_index += 1
    return peers[offset:] + peers[:offset]


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
    if runtime in ("mlx", "mlx_lm") and (supports_mlx or runtime == "mlx_lm"):
        return "velocity_mlx"
    if runtime == "vllm" and supports_vllm:
        return "velocity_vllm"
    return "legacy_pytorch"


def _runtime_for_pool(pool_class: str, worker: dict[str, Any] | None = None) -> str:
    if pool_class == "velocity_mlx":
        runtime = str((worker or {}).get("runtimeBackend") or (worker or {}).get("runtime_backend") or "").lower()
        return runtime if runtime in ("mlx", "mlx_lm") else "mlx"
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


def _normalize_model_id(value: Any) -> str | None:
    norm = _model_key(value)
    if not norm:
        return None
    if len(norm) > 140:
        return None
    # On enlève quelques préfixes d'origine qui peuvent varier selon la source d'annonce.
    if norm.startswith("hf://"):
        norm = norm[len("hf://"):]
    if norm.startswith("huggingface.co/"):
        norm = norm[len("huggingface.co/"):]
    if not norm:
        return None
    return norm


def _model_tail(value: Any) -> str:
    norm = _normalize_model_id(value) or ""
    if not norm:
        return ""
    return norm.split("/")[-1]


def _worker_matches_model(worker: dict[str, Any], model_id: Optional[str] = None) -> bool:
    advertised = _model_tail(worker.get("model") or worker.get("model_id"))
    expected = _model_tail(model_id or MODEL_ID)
    if not advertised:
        return False
    return advertised == expected or expected in advertised or advertised.endswith(f"/{expected}")


def _requires_distributed_shards(model_id: Optional[str] = None) -> bool:
    if LLAMA_CPP_DIRECT:
        return False
    norm = _model_key(model_id or MODEL_ID)
    tail = _model_tail(norm)
    # Les très gros modèles ne doivent jamais passer par le chemin direct
    # `mlx_lm.generate` : un worker tenterait de charger le modèle complet,
    # puis répondrait "shard-only", ce qui finit côté UI en "Réponse vide".
    if (
        "llama-2-70b" in norm
        or "llama2-70b" in norm
        or tail in {"llama-2-70b-hf", "llama-2-70b-chat-hf"}
        or "70b" in tail
    ):
        return True
    return (
        _env_bool("VRYX_WORKER_SHARD_ONLY", "0")
        or _env_bool("VRYX_EXPECT_MODEL_SHARDS_ONLY", "0")
        or _env_bool("VRYX_DISABLE_MLX_LM_DIRECT", "0")
    )


def _required_min_workers_for_model(model_id: Optional[str] = None) -> int:
    if _requires_distributed_shards(model_id):
        if ALLOW_SINGLE_WORKER_LARGE_LLAMA:
            return max(1, min(1, DIST_MIN_SHARDED_WORKERS))
        return max(2, DIST_MIN_SHARDED_WORKERS)
    return 1


def _max_context_tokens(model_config: Optional[dict[str, Any]]) -> int:
    if not isinstance(model_config, dict):
        return 4096
    for key in (
        "max_position_embeddings",
        "n_positions",
        "max_seq_len",
        "max_sequence_length",
        "seq_length",
    ):
        value = model_config.get(key)
        try:
            ivalue = int(value)
        except (TypeError, ValueError):
            continue
        if ivalue > 0:
            return ivalue
    return 4096


def _clamp_decode_cap(prompt_token_count: int, decode_cap: int, model_config: Optional[dict[str, Any]]) -> int:
    context_window = _max_context_tokens(model_config)
    safe_cap = max(0, context_window - max(0, prompt_token_count) - max(0, DIST_CONTEXT_SAFETY_TOKENS))
    if safe_cap <= 0:
        return 0
    requested_env_cap = os.environ.get("VRYX_DIST_MAX_CONTEXT_TOKENS")
    if requested_env_cap:
        try:
            cap = int(requested_env_cap)
            if cap > 0:
                context_window = min(context_window, cap)
                safe_cap = max(0, context_window - max(0, prompt_token_count) - max(0, DIST_CONTEXT_SAFETY_TOKENS))
        except (TypeError, ValueError):
            pass
    return max(0, min(decode_cap, safe_cap))


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


def _select_pool_peers(
    peers: list[str],
    catalog: dict[str, dict],
    preference: str,
    min_workers: int | None = None,
) -> tuple[list[str], str, str | None]:
    min_workers = max(1, int(min_workers or MIN_WORKERS))
    by_class: dict[str, list[str]] = {"velocity_mlx": [], "velocity_vllm": [], "legacy_pytorch": []}
    for peer in peers:
        by_class.setdefault(_worker_pool_class(catalog.get(peer) or {}), []).append(peer)
    if preference in ("velocity_mlx", "velocity_vllm", "legacy_pytorch"):
        selected = by_class.get(preference, [])
        if len(selected) >= min_workers:
            return selected, preference, None
        if preference != "legacy_pytorch" and len(by_class["legacy_pytorch"]) >= min_workers:
            return by_class["legacy_pytorch"], "legacy_pytorch", f"{preference}_insufficient_workers"
        return selected, preference, f"{preference}_insufficient_workers"
    if len(by_class["velocity_vllm"]) >= min_workers:
        return by_class["velocity_vllm"], "velocity_vllm", None
    if len(by_class["velocity_mlx"]) >= min_workers:
        return by_class["velocity_mlx"], "velocity_mlx", None
    return by_class["legacy_pytorch"] or peers, "legacy_pytorch", "velocity_pool_unavailable"


def _normalize_preferred_worker_peer_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        peer = str(item or "").strip()
        if not peer or peer in seen:
            continue
        seen.add(peer)
        out.append(peer)
    return out[:32]


def _apply_preferred_worker_order(
    peers: list[str],
    preferred_workers: list[str],
) -> tuple[list[str], list[str], list[str]]:
    if not preferred_workers:
        return peers, [], []
    available = set(peers)
    ordered = [peer for peer in preferred_workers if peer in available]
    missing = [peer for peer in preferred_workers if peer not in available]
    return ordered, ordered, missing


def _large_model_requires_real_accelerators() -> bool:
    if os.environ.get("VRYX_ALLOW_SHARED_ACCELERATOR_PEERS", "0").strip().lower() in ("1", "true", "yes", "on"):
        return False
    mid = str(MODEL_ID or "").lower()
    return any(marker in mid for marker in ("65b", "70b", "72b", "405b"))


def _is_llama70b_family(model_id: Optional[str] = None) -> bool:
    mid = str(model_id or MODEL_ID or "").lower()
    return "llama" in mid and any(marker in mid for marker in ("65b", "70b", "72b"))


def _large_llama_direct_preflight_error(peers: list[str], catalog: dict[str, dict]) -> Optional[dict[str, Any]]:
    if not LLAMA_CPP_DIRECT or ALLOW_EXPERIMENTAL_LLAMA70B_DIRECT or not _is_llama70b_family(MODEL_ID):
        return None
    rows = [(peer, catalog.get(peer) or {}) for peer in peers]
    if not rows:
        return {
            "reason": "no_worker",
            "detail": "Aucun worker compatible Llama n'est connecté.",
            "required_mb": LLAMA70B_Q4_MIN_WORKING_SET_MB,
        }
    budgets = []
    for peer, worker in rows:
        budget = _worker_memory_budget_mb(worker)
        budgets.append((peer, worker, budget))
    best_peer, best_worker, best_budget = max(budgets, key=lambda item: item[2])
    if best_budget >= LLAMA70B_Q4_MIN_WORKING_SET_MB:
        return None
    return {
        "reason": "insufficient_single_accelerator_memory",
        "detail": (
            "Llama 2 70B Q4 en mode llama.cpp direct demande un seul accélérateur capable "
            f"d'encaisser environ {LLAMA70B_Q4_MIN_WORKING_SET_MB / 1024:.1f} Go "
            "modèle + KV/cache/overhead. "
            f"Le meilleur worker visible annonce {best_budget / 1024:.1f} Go."
        ),
        "hint": (
            "Deux workers sur le même Mac ne doublent pas la VRAM. Pour ce modèle, il faut "
            "soit un vrai backend llama.cpp RPC/tensor-split sur plusieurs machines physiques, "
            "soit un worker unique avec plus de mémoire, soit un modèle Llama plus petit."
        ),
        "required_mb": LLAMA70B_Q4_MIN_WORKING_SET_MB,
        "best_peer": best_peer,
        "best_gpu": best_worker.get("gpuName") or best_worker.get("gpu_name") or "unknown",
        "best_budget_mb": best_budget,
    }


def _worker_accelerator_group(peer_id: str, worker: dict[str, Any]) -> str:
    """
    Identifiant conservateur d'un accélérateur physique.

    Le heartbeat actuel n'expose pas encore de UUID GPU stable côté macOS. Pour
    éviter de compter deux processus worker sur le même Mac comme deux VRAM
    indépendantes, on regroupe donc publicIp + nom GPU. Si un futur heartbeat
    expose gpuUuid/deviceId/hostId, il sera utilisé automatiquement.
    """
    gpu_uuid = str(worker.get("gpuUuid") or worker.get("gpu_uuid") or "").strip().lower()
    if gpu_uuid:
        return f"gpu:{gpu_uuid}"
    device_id = str(worker.get("deviceId") or worker.get("device_id") or "").strip().lower()
    host_id = str(worker.get("hostId") or worker.get("host_id") or worker.get("hostname") or "").strip().lower()
    if device_id and host_id:
        return f"host-device:{host_id}:{device_id}"
    public_ip = str(worker.get("publicIp") or worker.get("public_ip") or worker.get("ip") or "").strip().lower()
    gpu_name = str(worker.get("gpuName") or worker.get("gpu_name") or "").strip().lower()
    if public_ip and gpu_name:
        return f"public-gpu:{public_ip}:{gpu_name}"
    return f"peer:{peer_id}"


def _coalesce_shared_accelerator_peers(
    peers: list[str],
    catalog: dict[str, dict],
) -> tuple[list[str], list[dict[str, Any]]]:
    if not peers or not catalog or not _large_model_requires_real_accelerators():
        return peers, []

    groups: dict[str, list[str]] = {}
    for peer in peers:
        groups.setdefault(_worker_accelerator_group(peer, catalog.get(peer) or {}), []).append(peer)

    kept: list[str] = []
    coalesced: list[dict[str, Any]] = []
    for group, group_peers in groups.items():
        ranked = sorted(group_peers, key=lambda p: (-_worker_weight(p, catalog), p))
        winner = ranked[0]
        kept.append(winner)
        if len(ranked) > 1:
            sample = catalog.get(winner) or {}
            coalesced.append({
                "group": group,
                "kept_peer": winner,
                "ignored_peers": ranked[1:],
                "gpu": sample.get("gpuName") or sample.get("gpu_name") or "unknown",
                "public_ip": sample.get("publicIp") or sample.get("public_ip") or sample.get("ip") or "",
                "reason": "shared_physical_accelerator",
            })
    if coalesced:
        print(
            "[VPS] Placement gros modèle : workers fusionnés car ils partagent le même accélérateur physique : "
            + "; ".join(
                f"{str(item['kept_peer'])[:12]}… garde {len(item['ignored_peers'])} doublon(s) "
                f"sur {item.get('gpu') or 'GPU'}"
                for item in coalesced
            )
        )
    return sorted(kept), coalesced


def _vps_rtt_ms(peer_id: str, latency_matrix: dict[str, Any]) -> Optional[int]:
    value = (latency_matrix.get("vps_to_worker", {}).get(peer_id) or {}).get("vps_rtt_ms")
    return value if isinstance(value, int) else None


def _order_peers_for_vps_latency(peers: list[str], catalog: dict[str, dict], latency_matrix: dict[str, Any]) -> list[str]:
    return sorted(
        peers,
        key=lambda peer: (
            _vps_rtt_ms(peer, latency_matrix) if _vps_rtt_ms(peer, latency_matrix) is not None else HOT_POOL_MAX_RTT_MS * 4,
            -_worker_weight(peer, catalog),
            peer,
        ),
    )


def _microbatch_cap_for_rtt(routing_path: list[str], latency_matrix: dict[str, Any]) -> int:
    if not routing_path:
        return DECODE_MICROBATCH_CAP
    rtts = [
        _vps_rtt_ms(peer, latency_matrix)
        for peer in routing_path
        if _vps_rtt_ms(peer, latency_matrix) is not None
    ]
    if not rtts:
        return DECODE_MICROBATCH_CAP
    max_rtt = max(rtts)
    if max_rtt <= MICROBATCH_RTT_TARGET_MS:
        return DECODE_MICROBATCH_CAP
    ratio = max(1.0, max_rtt / max(1.0, MICROBATCH_RTT_TARGET_MS))
    return max(2, min(DECODE_MICROBATCH_CAP, int(DECODE_MICROBATCH_CAP / ratio)))


def _requires_mlx_lm_direct_guard() -> bool:
    normalized = MODEL_ID.lower().replace("_", "-")
    return (
        MLX_LM_DIRECT
        and ("qwen3.5" in normalized or "qwen3-5" in normalized or "qwen3.6" in normalized or "qwen3-6" in normalized)
        and not _requires_distributed_shards(MODEL_ID)
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _short(peer_id: str) -> str:
    return (peer_id or "")[:16]


def _assert_shard_cache_disk() -> tuple[bool, str]:
    """Vérifie l'espace disque du répertoire de cache shards avant préparation."""
    if SHARD_MIN_FREE_MB <= 0:
        return True, ""
    try:
        usage = shutil.disk_usage(SHARD_BASE_DIR)
    except Exception as exc:
        return False, f"[ERR] Impossible de lire l'espace disque sur {SHARD_BASE_DIR}: {exc}"
    available_mb = usage.free // (1024 * 1024)
    if available_mb < SHARD_MIN_FREE_MB:
        return (
            False,
            f"[ERR] Pas assez d'espace disque pour le cache shards ({available_mb} MB < {SHARD_MIN_FREE_MB} MB) sur {SHARD_BASE_DIR}",
        )
    return True, f"[OK] Espace disque shard suffisant : {available_mb} MB disponibles sur {SHARD_BASE_DIR}"


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
_model_lock = threading.RLock()
_model_runtime_lock = threading.RLock()
_model_config_cache: Optional[dict] = None
_model_cache_by_id: dict[str, tuple[Any, Any, Optional[dict]]] = {}


def _normalize_runtime_model_id(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    model_id = value.strip()
    if not model_id or len(model_id) > 120:
        return None
    if not re.match(r"^[A-Za-z0-9._/:-]+$", model_id):
        return None
    return model_id


def _canonical_runtime_model_id(model_id: Optional[str]) -> Optional[str]:
    if not model_id:
        return None
    key = _model_key(model_id)
    tail = _model_tail(key)
    # Le repo Meta officiel peut être gated même avec un token HF. Pour le pipeline
    # shard-only, on utilise le miroir public comme source de poids, tout en gardant
    # la compatibilité workers via _worker_matches_model() qui compare le nom final.
    if key.startswith("meta-llama/") and tail in {"llama-2-70b-hf", "llama-2-70b-chat-hf"}:
        return f"NousResearch/{tail}"
    return model_id


def _activate_model_id(model_id: Any) -> str:
    global MODEL_ID, _model, _tokenizer, _model_config_cache
    requested = _canonical_runtime_model_id(_normalize_runtime_model_id(model_id))
    if not requested or _model_key(requested) == _model_key(MODEL_ID):
        return MODEL_ID
    with _model_lock:
        if _model is not None or _tokenizer is not None or _model_config_cache is not None:
            _model_cache_by_id[MODEL_ID] = (_model, _tokenizer, _model_config_cache)
        MODEL_ID = requested
        cached = _model_cache_by_id.get(MODEL_ID)
        if cached:
            _model, _tokenizer, _model_config_cache = cached
        else:
            _model = None
            _tokenizer = None
            _model_config_cache = None
        print(f"[VPS] Modèle actif demandé par la session : {MODEL_ID}", flush=True)
    return MODEL_ID


def _live_worker_model_id() -> Optional[str]:
    scores: dict[str, tuple[int, float]] = {}
    for worker in _fetch_workers_public_status_payload():
        if str(worker.get("mode") or "").lower() != "worker":
            continue
        model_id = _normalize_runtime_model_id(worker.get("model") or worker.get("model_id"))
        if not model_id:
            continue
        try:
            heartbeat_age = float(worker.get("secondsSinceHeartbeat") or 0)
        except (TypeError, ValueError):
            heartbeat_age = 0.0
        if heartbeat_age > 120:
            continue
        count, best_age = scores.get(model_id, (0, 999999.0))
        scores[model_id] = (count + 1, min(best_age, heartbeat_age))
    if not scores:
        return None
    return sorted(scores.items(), key=lambda item: (-item[1][0], item[1][1]))[0][0]


def _activate_model_from_options(options: Optional[dict[str, Any]]) -> str:
    opts = options or {}
    requested = opts.get("model_id") or opts.get("modelId") or _live_worker_model_id()
    return _activate_model_id(requested)


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


def _format_prompt_for_model(
    prompt: str,
    tokenizer: Any,
    model_config: Optional[dict[str, Any]] = None,
) -> str:
    """
    Formatte le prompt selon le style attendu par le modèle (chat template si disponible).

    On réutilise la même logique pour le mode direct et le mode pipeline afin que la
    tokenisation, la limite de contexte et les métriques soient cohérentes.
    """
    model_type = (model_config or {}).get("model_type", "gpt2")
    if model_type == "gpt2":
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        return f"Question: {prompt}\nRéponse:"

    system_msg = (
        "Tu es l'assistant Vryx, une interface de chat connectée au réseau de calcul Vryx. "
        f"Le modèle LLM actuellement utilisé est {MODEL_ID}. "
        "Si l'utilisateur demande qui tu es, quel LLM te fait tourner, ton cerveau ou ton modèle, "
        "réponds honnêtement avec ce modèle et précise que Vryx est l'interface/réseau, pas le nom du LLM. "
        "Réponds directement dans la langue de l'utilisateur. "
        "Ne montre pas de raisonnement interne et arrête-toi après la réponse."
    )
    messages = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": prompt},
    ]
    try:
        try:
            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        return f"{prompt}\n"


def _tokenize_prompt(prompt: str, tokenizer: Any, model_config: Optional[dict[str, Any]] = None) -> tuple[str, list[int]]:
    """Retourne le prompt formaté et ses token_ids."""
    formatted = _format_prompt_for_model(prompt, tokenizer, model_config)
    try:
        ids = tokenizer.encode(formatted, add_special_tokens=True)
        if isinstance(ids, int):
            ids = [ids]
    except Exception:
        ids = []
    return formatted, ids


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
        "hidden_act": getattr(text_cfg, "hidden_act", "silu"),
        "attention_bias": bool(getattr(text_cfg, "attention_bias", False)),
        "mlp_bias": bool(getattr(text_cfg, "mlp_bias", False)),
        "tie_word_embeddings": bool(getattr(text_cfg, "tie_word_embeddings", False)),
        "rope_theta": rope_theta,
        "max_position_embeddings": getattr(text_cfg, "max_position_embeddings", None) or getattr(text_cfg, "n_positions", 1024),
        "layer_types": _jsonable(getattr(text_cfg, "layer_types", None)),
        "rope_parameters": rope_parameters,
        # Qwen3.6 / Qwen3.5 MoE fields
        "head_dim": getattr(text_cfg, "head_dim", None),
        "linear_conv_kernel_dim": getattr(text_cfg, "linear_conv_kernel_dim", None),
        "linear_key_head_dim": getattr(text_cfg, "linear_key_head_dim", None),
        "linear_value_head_dim": getattr(text_cfg, "linear_value_head_dim", None),
        "linear_num_key_heads": getattr(text_cfg, "linear_num_key_heads", None),
        "linear_num_value_heads": getattr(text_cfg, "linear_num_value_heads", None),
        "moe_intermediate_size": getattr(text_cfg, "moe_intermediate_size", None),
        "shared_expert_intermediate_size": getattr(text_cfg, "shared_expert_intermediate_size", None),
        "num_experts": getattr(text_cfg, "num_experts", None),
        "num_experts_per_tok": getattr(text_cfg, "num_experts_per_tok", None),
        "output_router_logits": bool(getattr(text_cfg, "output_router_logits", False)),
        "router_aux_loss_coef": getattr(text_cfg, "router_aux_loss_coef", 0.001),
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


def _local_model_snapshot_dir() -> str:
    raw = MODEL_SNAPSHOT_DIR.strip()
    if not raw:
        return ""
    return os.path.abspath(os.path.expanduser(raw))


def _direct_mlx_tokenizer_model_id() -> str:
    override = os.environ.get("VRYX_MLX_LM_MODEL_ID", "").strip()
    if override:
        return override
    normalized = MODEL_ID.lower()
    if "qwen3.6-35b-a3b" in normalized or "qwen3-6-35b-a3b" in normalized:
        return "mlx-community/Qwen3.6-35B-A3B-4bit"
    if "llama-2-70b" in normalized or "llama2-70b" in normalized or "70b" in normalized:
        return "mlx-community/llama2-70b-qnt4bit"
    return MODEL_ID


def _direct_mlx_worker_load_model_id() -> str:
    normalized = MODEL_ID.lower()
    if "qwen3.6-35b-a3b" in normalized or "qwen3-6-35b-a3b" in normalized:
        return "mlx-community/Qwen3.6-35B-A3B-4bit"
    if "qwen3.5-9b" in normalized or "qwen3-5-9b" in normalized:
        return "mlx-community/Qwen3.5-9B-4bit"
    if "llama-2-70b" in normalized or "llama2-70b" in normalized or "70b" in normalized:
        return "mlx-community/llama2-70b-qnt4bit"
    return os.environ.get("VRYX_MLX_LM_MODEL_ID", "").strip()


def _can_use_tokenizer_only_for_direct_mlx() -> bool:
    return bool(
        (
            (MLX_LM_DIRECT or LLAMA_CPP_DIRECT)
            and not _requires_distributed_shards(MODEL_ID)
        )
        or _prepared_gguf_session_dir()
    )


_SAFETENSOR_NUMPY_DTYPES = {
    "BF16": "bfloat16",
    "F16": "float16",
    "F32": "float32",
    "F64": "float64",
    "I8": "int8",
    "I16": "int16",
    "I32": "int32",
    "I64": "int64",
    "U8": "uint8",
    "U16": "uint16",
    "U32": "uint32",
    "U64": "uint64",
    "BOOL": "bool",
}


def _read_safetensor_offsets(path: str) -> dict[str, dict[str, Any]]:
    """Lit seulement le header safetensors pour obtenir les offsets bruts des tenseurs."""
    with open(path, "rb") as fp:
        raw_len = fp.read(8)
        if len(raw_len) != 8:
            raise RuntimeError(f"safetensors invalide (header absent): {path}")
        header_len = struct.unpack("<Q", raw_len)[0]
        header = json.loads(fp.read(header_len).decode("utf-8"))
    data_base = 8 + int(header_len)
    out: dict[str, dict[str, Any]] = {}
    for name, meta in header.items():
        if name == "__metadata__" or not isinstance(meta, dict):
            continue
        dtype_code = str(meta.get("dtype") or "")
        numpy_dtype = _SAFETENSOR_NUMPY_DTYPES.get(dtype_code)
        if not numpy_dtype:
            raise RuntimeError(
                f"dtype safetensors non supporté pour transfert range ({dtype_code}) dans {os.path.basename(path)}"
            )
        offsets = meta.get("data_offsets") or []
        if len(offsets) != 2:
            raise RuntimeError(f"offsets safetensors invalides pour {name}")
        start, end = int(offsets[0]), int(offsets[1])
        out[name] = {
            "shape": [int(x) for x in (meta.get("shape") or [])],
            "dtype": numpy_dtype,
            "source_offset": data_base + start,
            "nbytes": end - start,
        }
    return out


def _stage_safetensor_source(shard_dir: str, snapshot_dir: str, rel_path: str) -> str:
    """Expose un fichier HF dans le dossier shard sans le recopier (hardlink puis symlink)."""
    clean_rel = os.path.normpath(str(rel_path)).replace("\\", "/")
    if clean_rel.startswith("../") or clean_rel == ".." or os.path.isabs(clean_rel):
        raise RuntimeError(f"chemin safetensors invalide: {rel_path}")
    src = os.path.abspath(os.path.join(snapshot_dir, clean_rel))
    snapshot_abs = os.path.abspath(snapshot_dir)
    if not src.startswith(snapshot_abs + os.sep):
        raise RuntimeError(f"chemin safetensors hors snapshot: {rel_path}")
    dst = os.path.join(shard_dir, "sources", clean_rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.lexists(dst):
        return clean_rel
    real_src = os.path.realpath(src)
    try:
        os.link(real_src, dst)
    except OSError:
        os.symlink(real_src, dst)
    return clean_rel


def _ensure_model():
    global _model, _tokenizer, _model_config_cache
    with _model_lock:
        if _model is not None:
            return _model, _tokenizer
        try:
            _prepare_hf_cache_env()
            token, token_source = _resolve_hf_token()
            token_hint = "avec token" if token is not None else "sans token"
            from huggingface_hub import snapshot_download
            from transformers import AutoConfig, AutoTokenizer
            t0 = time.perf_counter()
            local_snapshot = _local_model_snapshot_dir()
            if _prepared_gguf_session_dir():
                source_id = _direct_mlx_tokenizer_model_id()
                print(
                    f"[VPS] Mode GGUF préparé : aucun poids HF côté VPS; "
                    f"chargement tokenizer/config léger depuis {source_id}."
                )
                _tokenizer = AutoTokenizer.from_pretrained(source_id, trust_remote_code=True, token=token)
                cfg = AutoConfig.from_pretrained(source_id, trust_remote_code=True, token=token)
                snapshot_dir = snapshot_download(
                    source_id,
                    token=token,
                    local_files_only=False,
                    allow_patterns=[
                        "*.json",
                        "tokenizer*",
                        "*.model",
                        "*.tiktoken",
                        "merges.txt",
                        "vocab.*",
                        "special_tokens_map.json",
                        "generation_config.json",
                    ],
                )
            elif local_snapshot and _can_use_tokenizer_only_for_direct_mlx():
                source_id = _direct_mlx_tokenizer_model_id()
                print(
                    f"[VPS] Mode direct MLX: snapshot poids ignoré côté VPS; "
                    f"chargement tokenizer/config léger depuis {source_id}."
                )
                _tokenizer = AutoTokenizer.from_pretrained(source_id, trust_remote_code=True, token=token)
                cfg = AutoConfig.from_pretrained(source_id, trust_remote_code=True, token=token)
                snapshot_dir = snapshot_download(
                    source_id,
                    token=token,
                    local_files_only=False,
                    allow_patterns=[
                        "*.json",
                        "tokenizer*",
                        "*.model",
                        "*.tiktoken",
                        "merges.txt",
                        "vocab.*",
                        "special_tokens_map.json",
                        "generation_config.json",
                    ],
                )
            elif local_snapshot:
                if not os.path.isdir(local_snapshot):
                    if not _can_use_tokenizer_only_for_direct_mlx():
                        raise RuntimeError(
                            f"snapshot local introuvable: {local_snapshot}. "
                            "Place config/tokenizer/safetensors ici ou retire VRYX_MODEL_SNAPSHOT_DIR."
                        )
                    source_id = _direct_mlx_tokenizer_model_id()
                    print(
                        f"[VPS] Snapshot local absent ({local_snapshot}); mode direct MLX: "
                        f"chargement tokenizer/config léger depuis {source_id}."
                    )
                    _tokenizer = AutoTokenizer.from_pretrained(source_id, trust_remote_code=True, token=token)
                    cfg = AutoConfig.from_pretrained(source_id, trust_remote_code=True, token=token)
                    snapshot_dir = snapshot_download(
                        source_id,
                        token=token,
                        local_files_only=False,
                        allow_patterns=[
                            "*.json",
                            "tokenizer*",
                            "*.model",
                            "*.tiktoken",
                            "merges.txt",
                            "vocab.*",
                            "special_tokens_map.json",
                            "generation_config.json",
                        ],
                    )
                else:
                    print(f"[VPS] Chargement {MODEL_ID} depuis snapshot local : {local_snapshot}")
                    _tokenizer = AutoTokenizer.from_pretrained(
                        local_snapshot,
                        trust_remote_code=True,
                        local_files_only=True,
                    )
                    cfg = AutoConfig.from_pretrained(
                        local_snapshot,
                        trust_remote_code=True,
                        local_files_only=True,
                    )
                    snapshot_dir = local_snapshot
            else:
                if MODEL_LOCAL_ONLY:
                    if not _can_use_tokenizer_only_for_direct_mlx():
                        raise RuntimeError(
                            "VRYX_MODEL_LOCAL_ONLY=1 mais VRYX_MODEL_SNAPSHOT_DIR est vide. "
                            "Aucun appel Hugging Face ne sera fait."
                        )
                    source_id = _direct_mlx_tokenizer_model_id()
                    print(
                        f"[VPS] Mode direct MLX tokenizer-only : chargement tokenizer/config léger depuis {source_id}."
                    )
                    _tokenizer = AutoTokenizer.from_pretrained(source_id, trust_remote_code=True, token=token)
                    cfg = AutoConfig.from_pretrained(source_id, trust_remote_code=True, token=token)
                    snapshot_dir = snapshot_download(
                        source_id,
                        token=token,
                        local_files_only=False,
                        allow_patterns=[
                            "*.json",
                            "tokenizer*",
                            "*.model",
                            "*.tiktoken",
                            "merges.txt",
                            "vocab.*",
                            "special_tokens_map.json",
                            "generation_config.json",
                        ],
                    )
                else:
                    print(f"[VPS] Chargement {MODEL_ID} : authentification {token_hint} ({token_source}).")
                    _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True, token=token)
                    cfg = AutoConfig.from_pretrained(MODEL_ID, trust_remote_code=True, token=token)
                    snapshot_dir = snapshot_download(MODEL_ID, **_hf_snapshot_download_kwargs(token))
            weight_map = _load_safetensor_weight_map(snapshot_dir)
            if not weight_map:
                if not _can_use_tokenizer_only_for_direct_mlx():
                    raise RuntimeError("aucun poids safetensors trouvé dans le snapshot modèle")
                print("[VPS] Mode direct MLX: aucun poids requis côté VPS, tokenizer/config seulement.")
            _model_config_cache = _build_model_config(cfg)
            _model = {
                "snapshot_dir": snapshot_dir,
                "weight_map": weight_map,
                "config": _model_config_cache,
                "tokenizer_only": not bool(weight_map),
            }
            elapsed = int((time.perf_counter() - t0) * 1000)
            if weight_map:
                print(f"[VPS] Manifeste modèle prêt : {len(weight_map)} tenseurs sur disque, {elapsed}ms")
            else:
                print(f"[VPS] Tokenizer/config prêts pour direct MLX worker, {elapsed}ms")
        except Exception as e:
            hint = _hf_download_error_hint(e)
            print(f"[VPS] Impossible de charger {MODEL_ID} : {e}")
            if hint != str(e):
                print(f"[VPS] Détails : {hint}")
            _model = None
            _tokenizer = None
    return _model, _tokenizer


# ── Découverte des workers ─────────────────────────────────────────────────────

def _discover_tp_peers() -> tuple[bool, list[str]]:
    try:
        req = urllib.request.Request(f"{RELAY_URL}/api/tp-peers", method="GET")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        if j.get("ok") and isinstance(j.get("peers"), list):
            peers = [p for p in j["peers"] if isinstance(p, str) and p.strip()]
            return True, peers
        return True, []
    except Exception:
        return False, []


def _discover_local_heartbeat_peers() -> list[str]:
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
    return []


def _discover_live_peers() -> list[str]:
    # 0. Variable d'environnement explicite (priorité maximale)
    explicit = os.environ.get("VRYX_DIST_PEER_IDS", "").strip()
    if explicit:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    # 1. Relay Rust /api/tp-peers : seule source qui prouve une connexion P2P utilisable.
    tp_available, tp_peers = _discover_tp_peers()
    if tp_available:
        if not tp_peers:
            print("[VPS] Découverte pairs : /api/tp-peers vide ; fail rapide sans fallback heartbeat.")
        return tp_peers
    # 2. Fallbacks de compatibilité uniquement si l'endpoint P2P n'est pas joignable.
    local = _discover_local_heartbeat_peers()
    if local:
        print("[VPS] Découverte pairs : fallback heartbeat local utilisé car /api/tp-peers est indisponible.")
        return local
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
    Utilise d'abord la mémoire réellement allouée au worker. Si le heartbeat ne
    l'envoie pas, on retombe sur la VRAM totale puis sur une estimation prudente.
    """
    raw = float(
        worker.get("allocatedVramMb")
        or worker.get("allocated_vram_mb")
        or worker.get("gpuVramMb")
        or worker.get("gpu_vram_mb")
        or 0
    )
    if raw > 0:
        return raw
    mid = str(worker.get("model") or worker.get("model_id") or MODEL_ID).lower()
    if any(x in mid for x in ("0.5b", "0.6b", "1b", "1.5b", "2b", "3b")):
        return 6144.0
    if any(x in mid for x in ("9b", "8b", "7b")):
        return 16384.0
    if any(x in mid for x in ("32b", "34b", "35b")):
        return 49152.0
    if any(x in mid for x in ("72b", "70b", "65b")):
        return 98304.0
    return 8192.0


def _worker_weight(peer_id: str, catalog: dict[str, dict]) -> float:
    w = catalog.get(peer_id) or {}
    vram_mb = _implicit_vram_mb_for_weight(w)
    return max(1.0, (vram_mb / 1024.0) * _gpu_compute_hint(w))


def _worker_memory_budget_mb(worker: dict[str, Any]) -> float:
    allocated = worker.get("allocatedVramMb") or worker.get("allocated_vram_mb")
    try:
        allocated_mb = float(allocated or 0)
    except (TypeError, ValueError):
        allocated_mb = 0.0
    if allocated_mb > 0:
        return allocated_mb

    try:
        gpu_mb = float(worker.get("gpuVramMb") or worker.get("gpu_vram_mb") or 0)
    except (TypeError, ValueError):
        gpu_mb = 0.0
    try:
        pct = float(worker.get("memoryLimitPercent") or worker.get("memory_limit_percent") or 0)
    except (TypeError, ValueError):
        pct = 0.0
    if gpu_mb > 0 and pct > 0:
        return gpu_mb * max(1.0, min(100.0, pct)) / 100.0
    return gpu_mb


def _safe_weight_budget_mb(worker: dict[str, Any]) -> float:
    # Garde de la place pour activations, KV cache, process Python/MLX et fragmentation mémoire.
    return max(0.0, _worker_memory_budget_mb(worker) * 0.72)


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
        if entry == "models" or entry == GGUF_PREPARED_SESSION or entry.startswith("prepared-"):
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
    secret_token = os.environ.get("VRYX_WORKER_SECRET") or os.environ.get("WORKER_INFERENCE_DELEGATE_SECRET") or ""
    token_suffix = f"?token={secret_token}" if secret_token else ""
    bin_url = f"{api_base}/api/internal/shard-serve/{session_id}/{bin_filename}{token_suffix}"
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
    return f"{api_base}/api/internal/shard-serve/{session_id}/{json_filename}{token_suffix}"


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

    secret_token = os.environ.get("VRYX_WORKER_SECRET") or os.environ.get("WORKER_INFERENCE_DELEGATE_SECRET") or ""
    token_suffix = f"?token={secret_token}" if secret_token else ""

    if SHARD_TRANSFER_MODE not in ("packed", "bin", "binary"):
        api_base = _worker_shard_download_base_url()
        header_cache: dict[str, dict[str, dict[str, Any]]] = {}
        tensor_sources: list[dict[str, Any]] = []
        staged_files: set[str] = set()
        total_bytes = 0
        for src_name, dst_name in selected:
            rel_file = weight_map[src_name]
            if rel_file not in header_cache:
                full_path = os.path.join(snapshot_dir, rel_file)
                header_cache[rel_file] = _read_safetensor_offsets(full_path)
            tensor_meta = header_cache[rel_file].get(src_name)
            if tensor_meta is None:
                raise RuntimeError(f"poids absent du header safetensors : {src_name}")
            staged_rel = _stage_safetensor_source(shard_dir, snapshot_dir, rel_file)
            staged_files.add(staged_rel)
            nbytes = int(tensor_meta["nbytes"])
            total_bytes += nbytes
            file_url = f"{api_base}/api/internal/shard-serve/{session_id}/sources/{quote(staged_rel, safe='/')}{token_suffix}"
            tensor_sources.append({
                "name": dst_name,
                "source_name": src_name,
                "shape": tensor_meta["shape"],
                "dtype": tensor_meta["dtype"],
                "source_url": file_url,
                "source_file": staged_rel,
                "source_offset": int(tensor_meta["source_offset"]),
                "nbytes": nbytes,
            })

        manifest = {
            "format": "safetensors-ranges-v1",
            "session_id": session_id,
            "layer_start": layer_start,
            "layer_end": layer_end,
            "model_config": model_config,
            "has_embedding": has_embedding,
            "has_lm_head": has_lm_head,
            "ttl_sec": SHARD_TTL,
            "binary_total_bytes": total_bytes,
            "tensor_sources": tensor_sources,
            "source_files": sorted(staged_files),
        }
        with open(json_filepath, "w") as f:
            json.dump(manifest, f)

        json_kb = os.path.getsize(json_filepath) / 1e3
        print(
            f"[VPS] Shard worker-{peer_idx} ranges : {total_bytes / 1e6:.1f} MB référencés "
            f"+ {json_kb:.1f} KB manifeste ({len(tensor_sources)} params, {len(staged_files)} fichiers source)"
        )
        return f"{api_base}/api/internal/shard-serve/{session_id}/{json_filename}{token_suffix}"

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
    bin_url = f"{api_base}/api/internal/shard-serve/{session_id}/{bin_filename}{token_suffix}"
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
    return f"{api_base}/api/internal/shard-serve/{session_id}/{json_filename}{token_suffix}"


def _prepared_gguf_session_dir() -> str:
    if GGUF_PREPARED_SESSION_DIR:
        return os.path.abspath(os.path.expanduser(GGUF_PREPARED_SESSION_DIR))
    if GGUF_PREPARED_SESSION:
        return os.path.join(SHARD_BASE_DIR, GGUF_PREPARED_SESSION)
    return ""


def _save_shard_to_disk_from_prepared_gguf(
    session_id: str,
    peer_idx: Any,
    peer_id: str,
    model_config: dict,
) -> tuple[str, int, int, bool, bool]:
    """
    Recycle un manifeste GGUF préparé hors requête.

    Le manifeste garde les ranges vers le .gguf source ; on le copie seulement
    dans le dossier de session courant en ajoutant le `model_config` chargé par
    l'initiateur. Aucun poids n'est chargé sur le VPS.
    """
    prepared_dir = _prepared_gguf_session_dir()
    if not prepared_dir or not os.path.isdir(prepared_dir):
        raise RuntimeError(
            "VRYX_GGUF_PREPARED_SESSION(_DIR) manquant ou introuvable. "
            "Lance prepare_gguf_worker_manifests.py avant Llama 70B Q4."
        )
    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for file_name in sorted(os.listdir(prepared_dir)):
        if not (file_name.startswith("worker-") and file_name.endswith(".json")):
            continue
        path = os.path.join(prepared_dir, file_name)
        try:
            data = json.load(open(path, "r", encoding="utf-8"))
        except Exception:
            continue
        try:
            rank = int(data.get("rank") if data.get("rank") is not None else file_name.split("-", 1)[1].split(".", 1)[0])
        except Exception:
            rank = len(candidates)
        candidates.append((rank, path, data))
    if not candidates:
        raise RuntimeError(f"aucun manifeste GGUF worker-*.json dans {prepared_dir}")

    selected: tuple[int, str, dict[str, Any]] | None = None
    for item in candidates:
        target = str(item[2].get("target_peer_id") or "")
        if target and target == peer_id:
            selected = item
            break
    if selected is None:
        rank_idx = int(peer_idx) if isinstance(peer_idx, int) or str(peer_idx).isdigit() else len(candidates)
        for item in candidates:
            if item[0] == rank_idx:
                selected = item
                break
    if selected is None:
        raise RuntimeError(f"manifeste GGUF introuvable pour peer={peer_id[:16]} rank={peer_idx}")

    _rank, _path, manifest = selected
    shard_dir = os.path.join(SHARD_BASE_DIR, session_id)
    os.makedirs(shard_dir, exist_ok=True)
    out_path = os.path.join(shard_dir, f"worker-{peer_idx}.json")
    out = dict(manifest)
    out.update({
        "session_id": session_id,
        "model_config": model_config,
        "ttl_sec": SHARD_TTL,
    })
    # Normaliser ces valeurs depuis le manifeste préparé ; elles remplacent le
    # découpage pondéré HF car le placement Q4 est VRAM-aware.
    layer_start = int(out.get("layer_start") or 0)
    layer_end = int(out.get("layer_end") or layer_start)
    has_embedding = bool(out.get("has_embedding"))
    has_lm_head = bool(out.get("has_lm_head"))
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False)
    api_base = _worker_shard_download_base_url()
    secret_token = os.environ.get("VRYX_WORKER_SECRET") or os.environ.get("WORKER_INFERENCE_DELEGATE_SECRET") or ""
    token_suffix = f"?token={secret_token}" if secret_token else ""
    print(
        f"[VPS] Shard GGUF préparé worker-{peer_idx}: peer={peer_id[:16]} "
        f"layers {layer_start}-{layer_end}, {int(out.get('binary_total_bytes') or 0) / 1e9:.2f}GB"
    )
    return (
        f"{api_base}/api/internal/shard-serve/{session_id}/worker-{peer_idx}.json{token_suffix}",
        layer_start,
        layer_end,
        has_embedding,
        has_lm_head,
    )


def _prepared_gguf_assignments_for_peers(peers: list[str]) -> list[tuple[str, int, int, bool, bool]] | None:
    prepared_dir = _prepared_gguf_session_dir()
    if not prepared_dir or not os.path.isdir(prepared_dir):
        return None
    manifests: list[tuple[int, dict[str, Any]]] = []
    for file_name in sorted(os.listdir(prepared_dir)):
        if not (file_name.startswith("worker-") and file_name.endswith(".json")):
            continue
        try:
            data = json.load(open(os.path.join(prepared_dir, file_name), "r", encoding="utf-8"))
        except Exception:
            continue
        try:
            rank = int(data.get("rank") if data.get("rank") is not None else file_name.split("-", 1)[1].split(".", 1)[0])
        except Exception:
            rank = len(manifests)
        manifests.append((rank, data))
    if not manifests:
        return None
    manifests.sort(key=lambda x: x[0])
    by_peer = {str(m.get("target_peer_id") or ""): m for _, m in manifests if str(m.get("target_peer_id") or "")}
    out: list[tuple[str, int, int, bool, bool]] = []
    used: set[str] = set()
    for _rank, manifest in manifests:
        target = str(manifest.get("target_peer_id") or "")
        peer = target if target in peers else ""
        if not peer:
            remaining = [p for p in peers if p not in used]
            if not remaining:
                break
            peer = remaining[0]
        used.add(peer)
        out.append((
            peer,
            int(manifest.get("layer_start") or 0),
            int(manifest.get("layer_end") or 0),
            bool(manifest.get("has_embedding")),
            bool(manifest.get("has_lm_head")),
        ))
    return out if len(out) >= min(len(peers), len(manifests)) else None


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
_SESSION_CACHE_KEY_VERSION = "v4-gguf-lazy-pool-registry"


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
    transport_samples = []
    for item in result.get("results", []):
        if isinstance(item, dict):
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            transport_samples.append({
                "peer": item.get("peer"),
                "quic_available": bool(data.get("quic_available")),
                "quic_used": bool(data.get("quic_used")),
                "connection_transport": data.get("connection_transport"),
                "fallback": data.get("fallback"),
            })
    return {
        "ok": result.get("ok", False),
        "enabled": True,
        "quic_available": available,
        "quic_used": available,
        "native_transport_verified": available and all(t.get("quic_used") for t in transport_samples),
        "transport_samples": transport_samples,
        "relay_transport": "libp2p_request_response",
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


def _session_ready_from_status(
    status: dict[str, Any],
    session_id: str,
    expected_model_id: Optional[str] = None,
) -> tuple[bool, str | None, dict[str, Any] | None]:
    if not status.get("ok", True):
        return False, str(status.get("error") or "status_unavailable"), None
    shards = status.get("shards") if isinstance(status, dict) else []
    if not isinstance(shards, list):
        return False, "status_shards_invalid", None
    for shard in shards:
        if not isinstance(shard, dict) or shard.get("session_id") != session_id:
            continue
        if expected_model_id and isinstance(shard.get("model_id"), str):
            if not _worker_matches_model({"model": shard.get("model_id")}, expected_model_id):
                return False, "shard_model_mismatch", shard
        ready = bool(shard.get("ready") or shard.get("built") or shard.get("build_ready"))
        weights_loaded = int(shard.get("weights_loaded") or 0)
        if ready and weights_loaded > 0:
            return True, None, shard
        return False, "shard_not_ready", shard
    return False, "session_unknown_on_worker", None


def _classify_runtime_pool(
    statuses: list[dict[str, Any]],
    session_id: str,
    requested_pool_class: str,
    expected_model_id: Optional[str] = None,
) -> dict[str, Any]:
    worker_runtime: dict[str, str] = {}
    worker_attention: dict[str, str] = {}
    worker_linear_ready: dict[str, bool] = {}
    ready_workers = 0
    reasons: list[str] = []

    for status in statuses:
        peer = str(status.get("peer_id") or "")
        ready, reason, shard = _session_ready_from_status(status, session_id, expected_model_id)
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


def _validate_cached_session(
    peers: list[str],
    session_id: str,
    requested_pool_class: str,
    expected_model_id: Optional[str] = None,
) -> dict[str, Any]:
    statuses = [_query_worker_status(peer, session_id) for peer in peers]
    truth = _classify_runtime_pool(statuses, session_id, requested_pool_class, expected_model_id)
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
    total_vram = sum(int((catalog.get(p) or {}).get("allocatedVramMb") or (catalog.get(p) or {}).get("gpuVramMb") or 0) for p in peers)
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
            validation = _validate_cached_session(sticky_path, session_id, pool_class, MODEL_ID)
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
        prepared_gguf_assignments = _prepared_gguf_assignments_for_peers(peers)
        if prepared_gguf_assignments:
            assignments = prepared_gguf_assignments
            peers[:] = [a[0] for a in assignments]
            print(f"[VPS] Placement GGUF préparé actif ({len(assignments)} workers) : {[p[:12] for p in peers]}")
        else:
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
                    "allocated_vram_mb": (catalog.get(peer) or {}).get("allocatedVramMb"),
                    "memory_limit_percent": (catalog.get(peer) or {}).get("memoryLimitPercent"),
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
            init_attempts = max(1, int(os.environ.get("VRYX_SHARD_INIT_ATTEMPTS", "2")))
            for attempt in range(init_attempts):
                t0 = time.perf_counter()
                r = _relay_raw(peer, "vryx.shard.init", init_payload, timeout=SHARD_INIT_TIMEOUT)
                elapsed = int((time.perf_counter() - t0) * 1000)
                relay_ok = r.get("ok") is not False and not str(r.get("error") or "").strip()
                if relay_ok:
                    break
                print(
                    f"[VPS] Worker {i} ({peer[:16]}) relay failed "
                    f"(attempt {attempt+1}/{init_attempts}, timeout={int(SHARD_INIT_TIMEOUT)}s) : {r.get('error')}"
                )
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
                    while time.perf_counter() - wait_started < SHARD_READY_TIMEOUT:
                        status = _query_worker_status(peer, session_id)
                        ready, reason, shard_hit = _session_ready_from_status(status, session_id, MODEL_ID)
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
                    print(
                        f"[VPS] Worker {i} ({peer[:16]}) timeout readiness après init "
                        f"({int(SHARD_READY_TIMEOUT)}s)"
                    )
                    diag.append({
                        "worker_index": i,
                        "peer": peer[:48],
                        "phase": "ready_poll_timeout",
                        "detail": (
                            f"worker_not_ready_after_{int(SHARD_READY_TIMEOUT)}s: "
                            f"{last_reason or 'session_not_ready'}"
                        )[:500],
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
        capacity_errors: list[dict[str, Any]] = []
        for i, (peer, ls, le, has_emb, has_head) in enumerate(assignments):
            if _prepared_gguf_session_dir():
                download_url, ls, le, has_emb, has_head = _save_shard_to_disk_from_prepared_gguf(
                    session_id, i, peer, model_config
                )
            else:
                download_url = _save_shard_to_disk_from_safetensors(
                    session_id, i, ls, le, has_emb, has_head, model_manifest, model_config
                )
            try:
                manifest_path = os.path.join(SHARD_BASE_DIR, session_id, f"worker-{i}.json")
                with open(manifest_path, "r", encoding="utf-8") as fp:
                    manifest_bytes = int((json.load(fp) or {}).get("binary_total_bytes") or 0)
            except Exception:
                manifest_bytes = 0
            worker_info = catalog.get(peer) or {}
            safe_mb = _safe_weight_budget_mb(worker_info)
            required_mb = manifest_bytes / 1024 / 1024
            quant = os.environ.get("VRYX_WEIGHT_QUANTIZATION", "fp16").lower()
            if "q4" in quant or "4bit" in quant:
                required_mb *= 0.28
            elif "q8" in quant or "8bit" in quant:
                required_mb *= 0.55
            if manifest_bytes > 0 and safe_mb > 0 and required_mb > safe_mb and not _prepared_gguf_session_dir():
                capacity_errors.append({
                    "worker_index": i,
                    "peer": peer[:48],
                    "gpu": worker_info.get("gpuName") or worker_info.get("gpu_name") or "unknown",
                    "layers": f"{ls}-{le}",
                    "required_weight_mb": round(required_mb, 1),
                    "safe_weight_budget_mb": round(safe_mb, 1),
                    "allocated_vram_mb": _worker_memory_budget_mb(worker_info),
                    "weight_quantization": quant,
                })
            init_jobs.append((i, peer, ls, le, has_emb, has_head, download_url))

        if capacity_errors:
            detail = "; ".join(
                f"w{e['worker_index']} {e['gpu']} layers {e['layers']}: "
                f"{e['required_weight_mb']}MB requis > {e['safe_weight_budget_mb']}MB sûrs"
                for e in capacity_errors[:4]
            )
            prep_diag.append({
                "worker_index": "capacity",
                "phase": "worker_vram_capacity",
                "detail": detail,
                "workers": capacity_errors,
                "hint": (
                    "Llama 2 70B fp16 ne tient pas sur cette chaîne. "
                    "Utilise un backend de poids Q4/Q8 shardé ou ajoute des workers/VRAM avant de lancer le dispatch."
                ),
            })
            print(f"[VPS] Dispatch refusé: capacité worker insuffisante. {detail}")
            _register_pool(pool_id, {"status": "failed", "session_status": "failed", "shard_prep_diag": prep_diag})
            return None, "failed", prep_diag

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

        validation = _validate_cached_session(peers, session_id, pool_class, MODEL_ID)
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
    prompt_token_count: int,
    peers: list[str],
    decode_cap: int,
    requested_quantization: str,
    pool_preference: str,
    formatted_prompt: str | None = None,
    options: Optional[dict[str, Any]] = None,
    latency_matrix: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    direct_enabled = MLX_LM_DIRECT or LLAMA_CPP_DIRECT
    if not direct_enabled or not peers:
        return None
    catalog = _fetch_worker_catalog()
    ready_peers, retry_after_ms = _mlx_direct_ready_peers(list(peers))
    lock_t0 = time.perf_counter()
    lock_timeout = max(1.0, min(float(PIPELINE_STEP_TIMEOUT), 120.0) - 1.0)
    if not ready_peers:
        first_peer = peers[0]
        return {
            "ok": False,
            "text": "",
            "error": "mlx_lm_no_available_worker: tous les workers compatibles sont occupés",
            "trace": {
                "layout": "mlx_lm_direct_p2p",
                "ok": False,
                "routing_path": [first_peer],
                "peers": list(peers),
                "failure_stage": "mlx_lm_direct_admission",
                "queue_wait_ms": int((time.perf_counter() - lock_t0) * 1000),
                "retry_after_ms": retry_after_ms,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }
    ready_peers = _rotate_direct_ready_peers(ready_peers)
    peer = None
    acquire_reason = "none"
    for candidate in ready_peers:
        acquired, acquire_reason, retry_after_ms = _try_acquire_mlx_direct_peer(
            candidate,
            lease_sec=max(float(PIPELINE_STEP_TIMEOUT), float(MLX_DIRECT_RELAY_TIMEOUT)) + 15.0,
        )
        if acquired:
            peer = candidate
            break
    if not peer:
        first_peer = ready_peers[0]
        return {
            "ok": False,
            "text": "",
            "error": f"mlx_lm_no_available_worker: admission refusée ({acquire_reason})",
            "trace": {
                "layout": "mlx_lm_direct_p2p",
                "ok": False,
                "routing_path": [first_peer],
                "peers": list(peers),
                "failure_stage": "mlx_lm_direct_admission",
                "queue_wait_ms": int((time.perf_counter() - lock_t0) * 1000),
                "retry_after_ms": retry_after_ms,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }
    worker_row = catalog.get(peer) or {}
    worker_runtime = str(
        worker_row.get("runtimeBackend") or worker_row.get("runtime_backend") or ""
    ).strip().lower()
    if "llama" in worker_runtime or "gguf" in worker_runtime:
        direct_backend = "llama_cpp"
    elif "mlx" in worker_runtime:
        direct_backend = "mlx_lm"
    elif LLAMA_CPP_DIRECT and any(marker in str(MODEL_ID).lower() for marker in ("llama", "gemma")):
        direct_backend = "llama_cpp"
    else:
        direct_backend = "mlx_lm"
    resolved_prompt = formatted_prompt if isinstance(formatted_prompt, str) and formatted_prompt.strip() else prompt
    payload = {
        "model_id": MODEL_ID,
        "prompt": resolved_prompt,
        "formatted_prompt": bool(isinstance(formatted_prompt, str) and formatted_prompt.strip()),
        "max_new_tokens": decode_cap,
        "temperature": SAMPLING_TEMPERATURE,
        "top_p": SAMPLING_TOP_P,
        "top_k": SAMPLING_TOP_K,
        "repetition_penalty": REPETITION_PENALTY,
    }
    load_model_id = _direct_mlx_worker_load_model_id()
    if direct_backend == "mlx_lm" and load_model_id:
        payload["load_model_id"] = load_model_id
    if direct_backend == "llama_cpp":
        payload["load_model_id"] = os.environ.get("VRYX_LLAMA_CPP_MODEL", "vryx-llama2-70b-q4").strip() or "vryx-llama2-70b-q4"
        payload["use_generate"] = os.environ.get("VRYX_LLAMA_CPP_USE_GENERATE", "1").strip().lower() not in ("0", "false", "no", "off")
        payload["keep_alive"] = os.environ.get("VRYX_LLAMA_CPP_KEEP_ALIVE", "30m").strip() or "30m"
        payload["num_ctx"] = int(os.environ.get("VRYX_LLAMA_CPP_NUM_CTX", "2048") or "2048")
        payload["num_batch"] = int(os.environ.get("VRYX_LLAMA_CPP_NUM_BATCH", "512") or "512")
    for key in ("stream_id", "stream_secret", "stream_callback_url"):
        value = options.get(key) if isinstance(options, dict) else None
        if value:
            payload[key] = str(value)
    try:
        response: Optional[dict[str, Any]] = None
        relay: dict[str, Any] = {}
        t0 = time.perf_counter()
        direct_dtype = "vryx.llama_cpp.generate" if direct_backend == "llama_cpp" else "vryx.mlx_lm.generate"
        relay = _relay_raw(
            peer,
            direct_dtype,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            timeout=min(float(PIPELINE_STEP_TIMEOUT), float(MLX_DIRECT_RELAY_TIMEOUT)),
        )
        response = _decode_pipeline_response(relay)
        wall_ms = max(1, int((time.perf_counter() - t0) * 1000))
    finally:
        _release_mlx_direct_peer(peer)
    response = response or {}
    error_text = str(response.get("error") or "")
    if error_text.startswith("mlx_lm_busy") or error_text.startswith("llama_cpp_busy"):
        _mark_mlx_direct_peer_busy(peer, busy_sec=12.0)
        remaining_peers = [p for p in peers if p != peer]
        if remaining_peers:
            rerouted = _run_mlx_lm_direct_chat(
                prompt,
                tokenizer,
                prompt_token_count,
                remaining_peers,
                decode_cap,
                requested_quantization,
                pool_preference,
                formatted_prompt=formatted_prompt,
                options=options,
                latency_matrix=latency_matrix,
            )
            if rerouted:
                rerouted_trace = rerouted.setdefault("trace", {})
                rerouted_trace["rerouted_after_busy_peer"] = peer
                return rerouted
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
    error_text2 = str(response.get("error") or "")
    if error_text2.startswith("mlx_lm_direct_disabled") or error_text2.startswith("mlx_lm_no_mlx"):
        # Worker has old firmware (shard-only mode) — skip and reroute to next peer
        _mark_mlx_direct_peer_busy(peer, busy_sec=10.0)
        remaining_peers = [p for p in peers if p != peer]
        if remaining_peers:
            rerouted = _run_mlx_lm_direct_chat(
                prompt,
                tokenizer,
                prompt_token_count,
                remaining_peers,
                decode_cap,
                requested_quantization,
                pool_preference,
                formatted_prompt=formatted_prompt,
                options=options,
                latency_matrix=latency_matrix,
            )
            if rerouted:
                rerouted_trace = rerouted.setdefault("trace", {})
                rerouted_trace["rerouted_after_disabled_peer"] = peer
                rerouted_trace["disabled_peer_error"] = error_text2[:120]
                return rerouted
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
    prompt_tokens = max(0, int(prompt_token_count))
    if prompt_tokens <= 0:
        try:
            prompt_tokens = len(tokenizer.encode(resolved_prompt))
        except Exception:
            prompt_tokens = 0
    generation_ms = max(1, int(response.get("generation_ms") or wall_ms))
    decode_ms = max(1, int(response.get("eval_ms") or response.get("decode_ms") or generation_ms))
    response_actual_tps = float(response.get("actual_tps") or 0.0)
    actual_tps = response_actual_tps if response_actual_tps > 0 else (
        round(completion_tokens * 1000.0 / decode_ms, 3) if completion_tokens else 0
    )
    trace = {
        "layout": "llama_cpp_direct_p2p" if direct_backend == "llama_cpp" else "mlx_lm_direct_p2p",
        "ok": True,
        "routing_path": [peer],
        "peers": [peer],
        "model_id": MODEL_ID,
        "runtime_backend_per_worker": {peer: direct_backend},
        "pool_preference": pool_preference,
        "peer_latency_matrix": latency_matrix or {},
        "requested_quantization": requested_quantization,
        "effective_quantization": "gguf_q4_native" if direct_backend == "llama_cpp" else "mlx_lm_native",
        "compute_time_ms": decode_ms if direct_backend == "llama_cpp" else generation_ms,
        "wall_time_ms": wall_ms,
        "generation_wall_ms": generation_ms,
        "relay_ms": relay_ms,
        "setup_ms": int(response.get("load_ms") or 0),
        "eval_ms": int(response.get("eval_ms") or 0),
        "prompt_eval_ms": int(response.get("prompt_eval_ms") or 0),
        "mlx_lm_load_ms": int(response.get("mlx_lm_load_ms") or response.get("load_ms") or 0),
        "mlx_lm_cache_hit": bool(response.get("cache_hit")),
        "mlx_lm_cache_status": response.get("cache_status") or ("hit" if response.get("cache_hit") else "loaded"),
        "resident_model": bool(response.get("resident_model", True)),
        "model_cache_size": int(response.get("model_cache_size") or 0),
        "token_events": response.get("token_events") if isinstance(response.get("token_events"), list) else [],
        "tokens_generated": completion_tokens,
        "requested_max_tokens": response.get("requested_max_tokens"),
        "effective_max_tokens": response.get("effective_max_tokens"),
        "stop_reason": response.get("stop_reason"),
        "hot_path_tps": actual_tps,
        "benchmark": {
            "target_tps": 15,
            "target_ms_per_token": 66,
            "actual_ms_per_token": int(decode_ms / completion_tokens) if completion_tokens else 0,
            "actual_tps": actual_tps,
            "decode_mode": response.get("decode_mode") or ("llama_cpp_ollama_generate" if LLAMA_CPP_DIRECT else "mlx_lm_direct_stream_generate"),
            "routing_hops": 1,
            "relay_ms": relay_ms,
            "ttft_ms": response.get("ttft_ms"),
            "load_ms": response.get("load_ms"),
            "eval_ms": response.get("eval_ms"),
            "prompt_eval_ms": response.get("prompt_eval_ms"),
            "cache_hit": bool(response.get("cache_hit")),
            "runtime_backend": "llama_cpp" if LLAMA_CPP_DIRECT else "mlx_lm",
            "stop_reason": response.get("stop_reason"),
            "effective_max_tokens": response.get("effective_max_tokens"),
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
    stream_id = str(options.get("stream_id") or "")
    stream_secret = str(options.get("stream_secret") or "")
    stream_callback_url = str(options.get("stream_callback_url") or "")
    _activate_model_from_options(options)
    requested_quantization = _normalize_hidden_transport(
        options.get("hidden_transport") or options.get("quantization") or HIDDEN_TRANSPORT
    )
    hidden_transport = requested_quantization
    quantization_fallback_reason: Optional[str] = None
    pool_preference = _normalize_pool_preference(options.get("pool_preference"))
    pool_fallback_reason: Optional[str] = None
    scheduler_job_id = str(options.get("scheduler_job_id") or "").strip()
    preferred_worker_peer_ids = _normalize_preferred_worker_peer_ids(options.get("preferred_worker_peer_ids"))
    preferred_workers_applied: list[str] = []
    preferred_workers_missing: list[str] = []

    decode_cap = MAX_NEW_TOKENS
    _mnt = options.get("max_new_tokens")
    if _mnt is not None:
        try:
            raw_cap = int(_mnt)
            if raw_cap >= 1:
                decode_cap = min(MAX_NEW_TOKENS, raw_cap)
        except (TypeError, ValueError):
            pass

    requires_distributed_shards = _requires_distributed_shards(MODEL_ID)
    min_workers_required = _required_min_workers_for_model(MODEL_ID)
    wait_for_min = DIST_WAIT_FOR_MIN_WORKERS or requires_distributed_shards
    if requires_distributed_shards:
        disk_ok, disk_msg = _assert_shard_cache_disk()
        print(disk_msg)
        if not disk_ok:
            return {
                "ok": False,
                "text": "",
                "error": f"Erreur prérequis disque : {disk_msg}",
                "trace": {
                    "layout": "pipeline_relay_daisy_chain",
                    "ok": False,
                    "failure_stage": "shard_disk_precheck",
                    "requirements": {
                        "shard_base_dir": SHARD_BASE_DIR,
                        "required_free_mb": SHARD_MIN_FREE_MB,
                    },
                },
                "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }

    if LLAMA_CPP_DIRECT:
        model_manifest, tokenizer = {"model_id": MODEL_ID, "source": "llama_cpp_direct"}, None
    else:
        model_manifest, tokenizer = _ensure_model()
    if model_manifest is None or (tokenizer is None and not LLAMA_CPP_DIRECT):
        return {
            "ok": False,
            "text": "",
            "error": f"Modèle {MODEL_ID} non disponible. Vérifier le téléchargement.",
            "trace": {"layout": "pipeline_relay_daisy_chain", "ok": False},
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    peers_sorted: list[str] = []
    selection_latency_matrix = {"vps_to_worker": {}, "worker_to_worker": {}}
    catalog: dict[str, dict] = {}
    pool_class = "legacy_pytorch"
    pool_fallback_reason = None
    incompatible_model_peers: list[dict[str, Any]] = []
    shared_accelerator_groups: list[dict[str, Any]] = []
    worker_wait_timeout = DIST_WAIT_FOR_MIN_WORKERS_TIMEOUT_SEC
    if isinstance(options, dict) and options.get("stream_id"):
        worker_wait_timeout = min(worker_wait_timeout, ADMIN_STREAM_WORKER_WAIT_SEC)
    wait_deadline = time.perf_counter() + max(0.0, worker_wait_timeout)
    discovery_attempt = 0

    while True:
        discovery_attempt += 1
        peers_raw = _discover_live_peers()
        peers_sorted = sorted(set(peers_raw))
        catalog = _fetch_worker_catalog()

        # Ordre canonique : même ordre à chaque requête et pour les tranches shard.init (embedding → … → lm_head).
        # Sinon la clé de cache (sorted) peut correspondre à une autre permutation et le 1er hop reçoit token_ids
        # sur un worker « milieu » → pas de next_token_id, texte vide, message générique côté API.
        incompatible_model_peers = []
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

        selected_peers, pool_class, pool_fallback_reason = _select_pool_peers(
            peers_sorted,
            catalog,
            pool_preference,
            min_workers=min_workers_required,
        )
        peers_sorted = sorted(selected_peers)
        if preferred_worker_peer_ids:
            peers_sorted, preferred_workers_applied, preferred_workers_missing = _apply_preferred_worker_order(
                peers_sorted,
                preferred_worker_peer_ids,
            )
            if preferred_workers_applied:
                pool_fallback_reason = None
            else:
                pool_fallback_reason = "scheduler_preferred_workers_unavailable"
        peers_sorted = _filter_workers_by_catalog_public_ip_optional(peers_sorted, catalog)
        selection_latency_matrix = _refresh_latency_matrix(peers_sorted) if peers_sorted else {"vps_to_worker": {}, "worker_to_worker": {}}
        peers_sorted = _order_peers_for_vps_latency(peers_sorted, catalog, selection_latency_matrix)
        peers_sorted, shared_accelerator_groups = _coalesce_shared_accelerator_peers(peers_sorted, catalog)
        selection_latency_matrix = _refresh_latency_matrix(peers_sorted) if peers_sorted else {"vps_to_worker": {}, "worker_to_worker": {}}
        peers_sorted = _order_peers_for_vps_latency(peers_sorted, catalog, selection_latency_matrix)

        if len(peers_sorted) >= min_workers_required:
            break

        if not wait_for_min:
            break
        if time.perf_counter() >= wait_deadline:
            break
        print(
            f"[VPS] En attente de workers prêts pour le modèle {MODEL_ID} : "
            f"{len(peers_sorted)}/{min_workers_required} (tentative {discovery_attempt})"
        )
        time.sleep(DIST_WAIT_FOR_MIN_WORKERS_POLL_SEC)

    if len(peers_sorted) < min_workers_required:
        mismatch_note = ""
        if incompatible_model_peers:
            advertised = ", ".join(
                f"{str(p['peer_id'])[:12]}…={p['model']}" for p in incompatible_model_peers[:4]
            )
            mismatch_note = f" Workers incompatibles ignorés : {advertised}."
        timeout_suffix = ""
        if wait_for_min and time.perf_counter() >= wait_deadline:
            timeout_suffix = (
                f" J'ai attendu {worker_wait_timeout:g}s "
                "mais les workers nécessaires ne sont pas prêts."
            )
        shared_note = ""
        if shared_accelerator_groups:
            shared_note = (
                " Plusieurs workers détectés partagent le même GPU/foyer et ne sont comptés qu'une fois "
                "pour éviter de surévaluer la VRAM disponible."
            )
        return {
            "ok": False,
            "text": "",
            "error": (
                f"Pas assez de workers connectés ({len(peers_sorted)}/{min_workers_required} minimum). "
                f"Vérifiez les heartbeats vers l’API, le bootstrap P2P et le modèle déclaré ({MODEL_ID})."
                f"{mismatch_note}{shared_note}{timeout_suffix}"
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "peers": peers_sorted,
                "routing_path": peers_sorted,
                "min_workers_required": min_workers_required,
                "required_model": MODEL_ID,
                "scheduler_job_id": scheduler_job_id or None,
                "preferred_worker_peer_ids": preferred_worker_peer_ids,
                "preferred_workers_applied": preferred_workers_applied,
                "preferred_workers_missing": preferred_workers_missing,
                "incompatible_model_peers": incompatible_model_peers,
                "shared_accelerator_groups": shared_accelerator_groups,
                "peer_latency_matrix": selection_latency_matrix,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    # Tokenisation + mise en forme communes (cohérence directe + pipeline).
    model_config = _model_config_cache or {}
    if LLAMA_CPP_DIRECT and tokenizer is None:
        model_config = {
            "model_type": "llama_cpp_direct",
            "max_position_embeddings": int(os.environ.get("VRYX_LLAMA_CPP_NUM_CTX", "4096") or "4096"),
        }
        formatted_prompt, input_ids = prompt, []
    else:
        formatted_prompt, input_ids = _tokenize_prompt(prompt, tokenizer, model_config)
        decode_cap = _clamp_decode_cap(len(input_ids), decode_cap, model_config)
    if decode_cap <= 0:
        return {
            "ok": False,
            "text": "",
            "error": (
                "Prompt trop long pour la fenêtre de contexte de ce modèle. "
                "Réduis le prompt, ou baisse la taille du batch."
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": peers_sorted,
                "peers": peers_sorted,
                "failure_stage": "context_limit_exceeded",
                "prompt_tokens": len(input_ids),
                "shared_accelerator_groups": shared_accelerator_groups,
            },
            "metrics": {"prompt_tokens": len(input_ids), "completion_tokens": 0, "total_tokens": len(input_ids)},
        }

    direct_result = None
    if not requires_distributed_shards:
        direct_preflight_error = _large_llama_direct_preflight_error(peers_sorted, catalog)
        if direct_preflight_error:
            return {
                "ok": False,
                "text": "",
                "error": (
                    "Llama 70B Q4 ne peut pas être lancé de façon fiable sur la configuration worker actuelle. "
                    f"{direct_preflight_error.get('detail')} {direct_preflight_error.get('hint')}"
                ),
                "trace": {
                    "layout": "llama_cpp_direct_p2p",
                    "ok": False,
                    "routing_path": peers_sorted[:1],
                    "peers": peers_sorted,
                    "failure_stage": "llama70b_direct_capacity_preflight",
                    "capacity": direct_preflight_error,
                    "shared_accelerator_groups": shared_accelerator_groups,
                    "peer_latency_matrix": selection_latency_matrix,
                },
                "metrics": {"prompt_tokens": len(input_ids), "completion_tokens": 0, "total_tokens": len(input_ids)},
            }
        direct_result = _run_mlx_lm_direct_chat(
            prompt,
            tokenizer,
            len(input_ids),
            peers_sorted,
            decode_cap,
            requested_quantization,
            pool_preference,
            formatted_prompt,
            options,
            selection_latency_matrix,
        )
    if direct_result is not None:
        trace = direct_result.get("trace")
        if isinstance(trace, dict):
            trace["scheduler_job_id"] = scheduler_job_id or None
            trace["preferred_worker_peer_ids"] = preferred_worker_peer_ids
            trace["preferred_workers_applied"] = preferred_workers_applied
            trace["preferred_workers_missing"] = preferred_workers_missing
        return direct_result
    if _requires_mlx_lm_direct_guard():
        return {
            "ok": False,
            "text": "",
            "error": (
                "mlx_lm_direct_p2p obligatoire pour Qwen3.5-9B en production. "
                "Le fallback vers le backend shard custom est bloqué pour préserver la qualité et le TPS."
            ),
            "trace": {
                "layout": "mlx_lm_direct_p2p",
                "ok": False,
                "routing_path": peers_sorted[:1],
                "peers": peers_sorted,
                "failure_stage": "mlx_lm_direct_guard",
                "fallback_blocked": True,
                "model_id": MODEL_ID,
                "scheduler_job_id": scheduler_job_id or None,
                "preferred_worker_peer_ids": preferred_worker_peer_ids,
                "preferred_workers_applied": preferred_workers_applied,
                "preferred_workers_missing": preferred_workers_missing,
                "shared_accelerator_groups": shared_accelerator_groups,
                "peer_latency_matrix": selection_latency_matrix,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    n = _routing_pipeline_width(len(peers_sorted), min_workers=min_workers_required)
    peers = peers_sorted[:n]

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
        capacity_diag = next(
            (d for d in (shard_prep_diag or []) if d.get("phase") == "worker_vram_capacity"),
            None,
        )
        if shard_prep_diag:
            chunk = "; ".join(
                f"w{d.get('worker_index')}:{d.get('phase')}:{str(d.get('detail',''))[:100]}"
                for d in shard_prep_diag[:3]
            )
            detail_hint = f" Diagnostics orchestrateur : {chunk}."
        if capacity_diag:
            error_msg = (
                "Dispatch Llama 70B impossible avec la mémoire worker actuelle. "
                f"{capacity_diag.get('detail')}. "
                "Le pipeline a été arrêté avant téléchargement/build pour éviter une réponse vide ou un transport error. "
                f"{capacity_diag.get('hint') or ''}"
            )
        else:
            error_msg = (
                "Échec de préparation des shards sur les workers (téléchargement ou build). "
                "Vérifier les workers, l'espace disque VPS (VRYX_SHARD_BASE_DIR) et les URLs téléchargeables depuis les GPUs "
                "(VRYX_SHARD_DOWNLOAD_BASE_URL / domaine exposant /api/internal/shard-serve/…)." + detail_hint
            )
        return {
            "ok": False,
            "text": "",
            "error": error_msg,
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": peers,
                "peers": peers,
                "setup_ms": setup_ms,
                "session_status": sess_status,
                "shard_prep_diag": shard_prep_diag,
                "shared_accelerator_groups": shared_accelerator_groups,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
    if sess_status == "created":
        print(f"[VPS] Setup poids en {setup_ms}ms")
    pool_info = _pool_for_session(session_id)
    latency_matrix_for_decode = pool_info.get("peer_latency_matrix") or selection_latency_matrix
    dynamic_microbatch_cap = _microbatch_cap_for_rtt(peers, latency_matrix_for_decode)
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
    pool_validation = _classify_runtime_pool(worker_statuses, session_id, pool_class, MODEL_ID)
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

    # Réutilise la version tokenisée commune (alignement avec métriques / clamp contextuel).
    formatted = formatted_prompt
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
    streamed_text_sent = ""
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
            "connection_transport": result.get("connection_transport"),
            "quic_used": bool(result.get("quic_used")),
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
                    "connection_transport": result.get("connection_transport"),
                    "quic_used": bool(result.get("quic_used")),
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
        if stream_id and stream_secret and stream_callback_url and partial_text.startswith(streamed_text_sent):
            delta_text = partial_text[len(streamed_text_sent):]
            if delta_text:
                _emit_stream_callback_async(
                    stream_callback_url,
                    stream_id,
                    stream_secret,
                    "token",
                    {
                        "token": delta_text,
                        "index": len(generated_ids),
                        "elapsed_ms": int((time.perf_counter() - t_infer) * 1000),
                    },
                )
                streamed_text_sent = partial_text
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
            micro_budget = max(2, min(dynamic_microbatch_cap, remaining_gen))

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
    if stream_id and stream_secret and stream_callback_url and response_text.startswith(streamed_text_sent):
        tail_text = response_text[len(streamed_text_sent):]
        if tail_text:
            _emit_stream_callback_async(
                stream_callback_url,
                stream_id,
                stream_secret,
                "token",
                {
                    "token": tail_text,
                    "index": len(generated_ids),
                    "elapsed_ms": int((time.perf_counter() - t_infer) * 1000),
                },
            )
    avg_ms = int(sum(step_latencies) / len(step_latencies)) if step_latencies else 0
    relay_ms_total = sum(int(m.get("relay_ms") or 0) for m in relay_metrics)
    serialization_ms_total = sum(int(m.get("serialization_ms") or 0) for m in relay_metrics)
    hidden_bytes_total = sum(int(m.get("hidden_bytes") or 0) for m in relay_metrics)
    relay_quic_used = any(bool(m.get("quic_used")) for m in relay_metrics)
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
        "scheduler_job_id": scheduler_job_id or None,
        "preferred_worker_peer_ids": preferred_worker_peer_ids,
        "preferred_workers_applied": preferred_workers_applied,
        "preferred_workers_missing": preferred_workers_missing,
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
        "shared_accelerator_groups": shared_accelerator_groups,
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
        "microbatch_tuning": {
            "enabled": DECODE_MICROBATCH,
            "configured_cap": DECODE_MICROBATCH_CAP,
            "dynamic_cap": dynamic_microbatch_cap,
            "rtt_target_ms": MICROBATCH_RTT_TARGET_MS,
        },
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
        "quic_used": bool(quic_probe.get("quic_used")) or relay_quic_used,
        "quic_probe": quic_probe,
        "quic_available": bool(quic_probe.get("quic_available")) or relay_quic_used,
        "quic_fallback_reason": quic_probe.get("fallback_reason") or ("disabled" if not HIDDEN_QUIC else None),
        "relay_transport_samples": [
            {
                "transport": m.get("connection_transport"),
                "quic_used": bool(m.get("quic_used")),
                "relay_ms": m.get("relay_ms"),
            }
            for m in relay_metrics
            if m.get("connection_transport")
        ],
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
             "hidden_bytes": (relay_metrics[i] if i < len(relay_metrics) else {}).get("hidden_bytes"),
             "connection_transport": (relay_metrics[i] if i < len(relay_metrics) else {}).get("connection_transport"),
             "quic_used": bool((relay_metrics[i] if i < len(relay_metrics) else {}).get("quic_used"))}
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

    if not response_text.strip():
        err = (
            "Décodage vide malgré des jetons générés : le modèle a probablement émis "
            "uniquement des tokens de fin/spéciaux, ou le tokenizer ne correspond pas au shard chargé."
        )
        base_trace["ok"] = False
        base_trace["error"] = err
        base_trace["generated_token_ids_sample"] = generated_ids[:32]
        return {
            "ok": False,
            "text": "",
            "error": err,
            "trace": base_trace,
            "metrics": {
                "prompt_tokens": len(input_ids),
                "completion_tokens": len(generated_ids),
                "total_tokens": len(input_ids) + len(generated_ids),
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
    options = options or {}
    with _model_runtime_lock:
        _activate_model_from_options(options)
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
                    "required_model": MODEL_ID,
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
                    "required_model": MODEL_ID,
                },
                "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
            }

        if result.get("trace") and result["trace"].get("layout") != "mlx_lm_direct_p2p":
            result["trace"]["layout"] = "pipeline_relay_daisy_chain"
        return result
