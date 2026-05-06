"""
Orchestrateur Pipeline Parallelism — Vryx DePIN.

Côté VPS / Initiateur :
 1. Charge Qwen/Qwen2.5-0.5B-Instruct en mémoire (une fois, mis en cache).
 2. À chaque session d'inférence, découpe les couches en N tranches et pousse
    chaque tranche au worker correspondant via /api/p2p/relay (vryx.shard.*).
 3. Lance la boucle autorégressive :
      - Tokenise le prompt → token_ids
      - Envoie à worker 1 via routing_path=[w1, w2, w3]
      - Le daemon Rust fait transiter les hidden_states de worker en worker
      - Reçoit le next_token_id du dernier worker
      - Dé-tokenise et boucle jusqu'à EOS ou MAX_NEW_TOKENS

Variables :
  VRYX_DIST_MODEL          Modèle HuggingFace (défaut : Qwen/Qwen2.5-0.5B-Instruct)
  VRYX_DIST_MAX_TOKENS     Tokens max générés (défaut : 256)
  VRYX_P2P_RELAY_URL       URL du daemon Rust initiateur (défaut : http://127.0.0.1:3031)
  VRYX_DIST_MAX_WORKERS    Workers max utilisés (défaut : 3)
  VRYX_DIST_TIMEOUT_SEC    Timeout par hop P2P (défaut : 60)
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional
import urllib.error
import urllib.request

import numpy as np

# ── Config ─────────────────────────────────────────────────────────────────────

MODEL_ID = os.environ.get("VRYX_DIST_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
MAX_NEW_TOKENS = int(os.environ.get("VRYX_DIST_MAX_TOKENS", "128"))
RELAY_URL = os.environ.get("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031").rstrip("/")
MAX_WORKERS = max(2, int(os.environ.get("VRYX_DIST_MAX_WORKERS", "3")))
MIN_WORKERS = max(2, int(os.environ.get("VRYX_DIST_MIN_WORKERS", "2")))
TIMEOUT = float(os.environ.get("VRYX_DIST_TIMEOUT_SEC", "120"))
SHARD_TTL = int(os.environ.get("VRYX_DIST_SHARD_TTL", "1800"))

# ── Modèle VPS (singleton) ─────────────────────────────────────────────────────

_model = None
_tokenizer = None
_model_lock = threading.Lock()
_model_config_cache: Optional[dict] = None


def _ensure_model():
    global _model, _tokenizer, _model_config_cache
    with _model_lock:
        if _model is not None:
            return _model, _tokenizer
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
            print(f"[VPS] Chargement {MODEL_ID} en float16…")
            t0 = time.perf_counter()
            _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
            _model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID,
                torch_dtype=torch.float16,
                device_map="cpu",
            )
            _model.eval()
            elapsed = int((time.perf_counter() - t0) * 1000)
            cfg = _model.config
            model_type = getattr(cfg, "model_type", "gpt2")
            _model_config_cache = {
                "model_type": model_type,
                # GPT-2 fields
                "hidden_size": getattr(cfg, "hidden_size", None) or getattr(cfg, "n_embd", 768),
                "num_hidden_layers_total": getattr(cfg, "num_hidden_layers", None) or getattr(cfg, "n_layer", 12),
                "num_attention_heads": getattr(cfg, "num_attention_heads", None) or getattr(cfg, "n_head", 12),
                "num_key_value_heads": getattr(cfg, "num_key_value_heads", None) or getattr(cfg, "n_head", 12),
                "intermediate_size": getattr(cfg, "intermediate_size", None) or getattr(cfg, "n_inner", None) or 3072,
                "vocab_size": cfg.vocab_size,
                # GPT-2 specific
                "n_positions": getattr(cfg, "n_positions", 1024),
                "n_embd": getattr(cfg, "n_embd", 768),
                "n_layer": getattr(cfg, "n_layer", 12),
                "n_head": getattr(cfg, "n_head", 12),
                "layer_norm_epsilon": getattr(cfg, "layer_norm_epsilon", 1e-5),
                "embd_pdrop": getattr(cfg, "embd_pdrop", 0.1),
                # Qwen2 specific (kept for compatibility)
                "rms_norm_eps": getattr(cfg, "rms_norm_eps", 1e-6),
                "rope_theta": getattr(cfg, "rope_theta", 10000.0),
                "max_position_embeddings": getattr(cfg, "max_position_embeddings", None) or getattr(cfg, "n_positions", 1024),
            }
            params = sum(p.numel() for p in _model.parameters())
            print(f"[VPS] Modèle prêt : {params:,} params, {elapsed}ms")
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
    # 2. Relay Rust /api/tp-peers
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
    return []


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
        # Qwen2 / LLaMA-style
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

def _relay_raw(peer_id: str, dtype: str, payload: bytes, timeout: float = TIMEOUT,
               routing_path: list | None = None) -> dict:
    url = f"{RELAY_URL}/api/p2p/relay"
    body = json.dumps({
        "target_peer": peer_id,
        "dtype": dtype,
        "data_b64": base64.standard_b64encode(payload).decode("ascii"),
        "routing_path": routing_path or [],
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_err = ""
        try:
            body_err = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {e.code}: {body_err}"}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


def _purge_old_shards(keep_session: str = "") -> None:
    """Supprime les anciens shards pour libérer /tmp."""
    base_dir = "/tmp/vryx-shards"
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
    shard_dir = f"/tmp/vryx-shards/{session_id}"
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

    # Manifeste JSON pour le worker
    api_base = os.environ.get("VRYX_API_URL", "https://vryx.eu").rstrip("/")
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
    r = _relay_raw(peer_id, "vryx.shard.init", init_payload, timeout=15.0)
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
            r = _relay_raw(peer_id, "vryx.shard.load", load_payload, timeout=60.0)
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
        r = _relay_raw(peer_id, "vryx.shard.build", build_payload, timeout=30.0)
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

# Incrémenter si la sémantique de la clé ou l'ordre des tranches change (sinon cache désaligné).
_SESSION_CACHE_KEY_VERSION = "v2-canonical-order"


def _get_or_create_session(peers: list[str], model_config: dict, model) -> tuple[Optional[str], str]:
    """
    Retourne (session_id, statut) avec statut parmi 'reused', 'created', 'failed'.
    En cas d'échec d'init / téléchargement, session_id est None (ne pas lancer l'inférence).
    """
    # Toujours la même clé et le même ordre de tranches que routing_path (pairs triés).
    key = _SESSION_CACHE_KEY_VERSION + "|" + "|".join(sorted(peers))
    with _worker_session_lock:
        if key in _worker_sessions:
            print(f"[VPS] Réutilisation session pour {len(peers)} workers")
            return _worker_sessions[key], "reused"

        session_id = f"vryx-{int(time.time() * 1000)}"
        n = len(peers)
        total_layers = model_config["num_hidden_layers_total"]
        base = total_layers // n
        remainder = total_layers % n

        assignments = []
        start = 0
        for i in range(n):
            n_layers = base + (1 if i < remainder else 0)
            end = start + n_layers - 1
            assignments.append((peers[i], start, end, i == 0, i == n - 1))
            start = end + 1

        # Purge des anciens shards pour libérer /tmp avant d'écrire les nouveaux
        _purge_old_shards(keep_session=session_id)

        print(f"[VPS] Préparation poids pour {n} workers (session {session_id[:20]})…")
        # Sauvegarder poids sur disque VPS → workers téléchargent directement via HTTPS
        
        def _init_worker(i: int, peer: str, ls: int, le: int, has_emb: bool, has_head: bool) -> bool:
            weights = _extract_worker_weights(model, ls, le, has_emb, has_head)
            download_url = _save_shard_to_disk(
                session_id, i, ls, le, has_emb, has_head, weights, model_config
            )
            init_payload = json.dumps({
                "session_id": session_id,
                "layer_start": ls,
                "layer_end": le,
                "model_config": model_config,
                "has_embedding": has_emb,
                "has_lm_head": has_head,
                "ttl_sec": SHARD_TTL,
                "download_url": download_url,
            }).encode()
            
            relay_ok = False
            r = {}
            elapsed = 0
            for attempt in range(3):
                t0 = time.perf_counter()
                r = _relay_raw(peer, "vryx.shard.init", init_payload, timeout=TIMEOUT * 2)
                elapsed = int((time.perf_counter() - t0) * 1000)
                relay_ok = r.get("ok") is not False and "error" not in str(r.get("error", "")).lower()
                if relay_ok:
                    break
                print(f"[VPS] Worker {i} ({peer[:16]}) relay failed (attempt {attempt+1}/3) : {r.get('error')}")
                time.sleep(2.0)
                
            if relay_ok:
                try:
                    inner_b64 = r.get("data_b64", "")
                    inner = json.loads(base64.b64decode(inner_b64).decode("utf-8", errors="replace")) if inner_b64 else {}
                    weights_loaded = inner.get("weights_loaded", 0)
                    inner_ok = inner.get("ok", True)
                    print(f"[VPS] Worker {i} ({peer[:16]}) : {weights_loaded} poids téléchargés en {elapsed}ms")
                    return inner_ok
                except Exception as e:
                    print(f"[VPS] Worker {i} parse response error : {e}")
                    return False
            else:
                print(f"[VPS] Worker {i} ({peer[:16]}) relay failed : {r.get('error')}")
                return False

        with ThreadPoolExecutor(max_workers=n) as executor:
            futures = [
                executor.submit(_init_worker, i, peer, ls, le, has_emb, has_head)
                for i, (peer, ls, le, has_emb, has_head) in enumerate(assignments)
            ]
            results = [f.result() for f in futures]

        if not all(results):
            print("[VPS] Certains workers n'ont pas reçu leurs poids.")
            return None, "failed"

        _worker_sessions[key] = session_id
        # TTL: supprimer après SHARD_TTL secondes
        def _expire():
            time.sleep(SHARD_TTL)
            with _worker_session_lock:
                _worker_sessions.pop(key, None)
        threading.Thread(target=_expire, daemon=True).start()

        return session_id, "created"


# ── Boucle autorégressive ─────────────────────────────────────────────────────

def run_pipeline_chat(prompt: str) -> dict:
    """
    Pipeline Parallelism réel :
      - VPS tokenise
      - Workers 1→2→3 exécutent chacun leur tranche de couches
      - Dernier worker retourne next_token_id
      - VPS dé-tokenise, boucle jusqu'à EOS
    """
    model, tokenizer = _ensure_model()
    if model is None or tokenizer is None:
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
    if len(peers_sorted) < MIN_WORKERS:
        # Pas assez de workers : retourne une ERREUR explicite (le VPS ne calcule jamais)
        return {
            "ok": False,
            "text": "",
            "error": (
                f"Pas assez de workers connectés ({len(peers_sorted)}/{MIN_WORKERS} minimum). "
                "Le VPS ne calcule pas : il faut au moins 2 nœuds GPU pour distribuer le modèle."
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "peers": peers_sorted,
                "routing_path": peers_sorted,
                "min_workers_required": MIN_WORKERS,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    n = min(len(peers_sorted), MAX_WORKERS)
    peers = peers_sorted[:n]
    model_config = _model_config_cache

    # Obtenir / créer la session de poids
    t_setup = time.perf_counter()
    session_id, sess_status = _get_or_create_session(peers, model_config, model)
    setup_ms = int((time.perf_counter() - t_setup) * 1000)
    if sess_status == "failed" or session_id is None:
        return {
            "ok": False,
            "text": "",
            "error": (
                "Échec de préparation des shards sur les workers (téléchargement ou build). "
                "Vérifier les workers et l'espace disque /tmp sur le VPS."
            ),
            "trace": {
                "layout": "pipeline_relay_daisy_chain",
                "ok": False,
                "routing_path": peers,
                "peers": peers,
                "setup_ms": setup_ms,
                "session_status": sess_status,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
    if sess_status == "created":
        print(f"[VPS] Setup poids en {setup_ms}ms")

    # Tokeniser le prompt (adapté selon le modèle)
    import torch
    model_type = model_config.get("model_type", "gpt2")
    if model_type == "gpt2":
        # GPT-2 : pas de chat template, prompt brut
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        formatted = f"Question: {prompt}\nRéponse:"
    else:
        system_msg = "Tu es Vryx, un assistant IA concis. Réponds dans la langue de l'utilisateur."
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": prompt},
        ]
        try:
            formatted = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            formatted = f"{prompt}\n"

    input_ids = tokenizer.encode(formatted, return_tensors="pt")[0].tolist()
    eos_id = tokenizer.eos_token_id
    routing_path = peers  # [w1, w2, w3]

    print(f"[VPS] Inférence : {len(input_ids)} tokens prompt, {n} workers, routing={[p[:12] for p in routing_path]}")

    generated_ids = []
    step_latencies = []
    failure_error: Optional[str] = None
    t_infer = time.perf_counter()

    # Payload initial : token_ids envoyés au premier worker
    current_payload = json.dumps({
        "session_id": session_id,
        "token_ids": input_ids,
        "step": 0,
        "seq_pos": 0,
    }).encode()

    current_dtype = "vryx.shard.pipeline"

    for step in range(MAX_NEW_TOKENS):
        t_step = time.perf_counter()
        result = _relay_raw(
            routing_path[0],
            current_dtype,
            current_payload,
            timeout=TIMEOUT,
            routing_path=routing_path[1:],
        )
        step_ms = int((time.perf_counter() - t_step) * 1000)
        step_latencies.append(step_ms)

        if not result.get("ok", True):
            err = result.get("error", "erreur inconnue")
            failure_error = f"Relais P2P étape {step} : {err}"
            print(f"[VPS] Step {step} failed : {err}")
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
            break

        next_token_id = response.get("next_token_id")
        if next_token_id is None:
            # Souvent : chaîne désalignée (ordre des pairs ≠ rôles embedding/lm_head) ou relais incomplet.
            failure_error = (
                response.get("error")
                or "Pas de next_token_id : le relais n'a pas atteint le worker tête LM ou "
                "le premier hop n'est pas celui avec embedding (vérifier l'ordre stable des pairs)."
            )
            print(f"[VPS] Pas de next_token_id dans la réponse : {str(response)[:200]}")
            break

        next_token_id = int(next_token_id)
        generated_ids.append(next_token_id)

        if next_token_id == eos_id:
            break

        # Prochain step : toute la séquence (pas de KV cache → contexte complet requis)
        all_ids = input_ids + generated_ids
        current_payload = json.dumps({
            "session_id": session_id,
            "token_ids": all_ids,
            "step": step + 1,
            "seq_pos": 0,
        }).encode()
        current_dtype = "vryx.shard.pipeline"

    total_ms = int((time.perf_counter() - t_infer) * 1000)
    response_text = tokenizer.decode(generated_ids, skip_special_tokens=True)
    avg_ms = int(sum(step_latencies) / len(step_latencies)) if step_latencies else 0

    print(f"[VPS] {len(generated_ids)} tokens en {total_ms}ms ({avg_ms}ms/tok)")

    base_trace: dict[str, Any] = {
        "layout": "pipeline_relay_daisy_chain",
        "routing_path": routing_path,
        "peers": routing_path,
        "session_id": session_id,
        "steps": [
            {"peer": routing_path[min(i, n - 1)], "rank": i, "role": "pipeline_layer_forward",
             "latency_ms": ms}
            for i, ms in enumerate(step_latencies[:len(routing_path)])
        ],
        "compute_time_ms": total_ms,
        "tokens_generated": len(generated_ids),
        "avg_ms_per_token": avg_ms,
        "setup_ms": setup_ms,
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


def maybe_run_worker_only_chat(prompt: str) -> dict | None:
    """Point d'entrée depuis inference_server.py."""
    peers = _discover_live_peers()
    if not peers:
        return None

    result = run_pipeline_chat(prompt)
    if result is None:
        return None

    if result.get("trace"):
        result["trace"]["layout"] = "pipeline_relay_daisy_chain"
    return result
