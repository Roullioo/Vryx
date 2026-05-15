"""
Worker-side Pipeline Parallelism — Vryx DePIN.

Chaque worker reçoit :
  1. vryx.shard.init   → métadonnées (couches à exécuter, config modèle)
  2. vryx.shard.load   → tranches de poids (float16 numpy, envoyées par le VPS)
  3. vryx.shard.forward → hidden_states (float16 bytes) ou token_ids JSON (1er worker)

Le VPS garde le modèle complet. Les workers n'ont JAMAIS besoin de télécharger quoi
que ce soit depuis HuggingFace : ils reçoivent les poids nécessaires depuis le VPS.

Sortie du dernier worker : JSON {"next_token_id": <int>}
Sortie des workers intermédiaires : bytes float16 = hidden_states

Variables worker (sélection backend) :
  VRYX_RUNTIME_BACKEND=mlx — prioritaire sur le meta envoyé par le VPS ; exige le chemin MLX.
  VRYX_MLX_STRICT=1 — avec mlx demandé : **aucun** fallback PyTorch silencieux ; échec explicite si MLX indisponible.
  VRYX_DISABLE_PYTORCH_FALLBACK=1 — même effet que MLX strict pour le refus de fallback (historique).
  VRYX_ENABLE_MLX_RUNTIME / VRYX_ENABLE_MLX_KERNELS — requis pour activer MLXBackend (voir mlx_backend.py).
"""
from __future__ import annotations

import base64
import json
import os
import copy
import threading
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol

import urllib.request
import numpy as np
import torch
import torch.nn.functional as F

warnings.filterwarnings("ignore")

# Téléchargement du manifeste shard depuis le VPS (HTTPS) : éviter 120 s trop court sur lien lent.
MANIFEST_FETCH_TIMEOUT_SEC = max(600.0, float(os.environ.get("VRYX_SHARD_MANIFEST_FETCH_TIMEOUT_SEC", "600")))
SHARD_BINARY_FETCH_TIMEOUT_SEC = max(600.0, float(os.environ.get("VRYX_SHARD_BINARY_FETCH_TIMEOUT_SEC", "600")))

# ── Imports transformers (architecture uniquement, pas de poids HF) ────────────
try:
    from transformers import Qwen2Config, GPT2Config, Qwen3_5TextConfig
    from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer, Qwen2RMSNorm
    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5DecoderLayer, Qwen3_5RMSNorm
    try:
        from transformers.models.qwen2.modeling_qwen2 import Qwen2RotaryEmbedding
    except ImportError:
        Qwen2RotaryEmbedding = None
    try:
        from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5TextRotaryEmbedding
    except ImportError:
        Qwen3_5TextRotaryEmbedding = None
    from transformers.models.gpt2.modeling_gpt2 import GPT2Block
    try:
        from transformers.cache_utils import DynamicCache
        _HAS_DYNAMIC_CACHE = True
    except ImportError:
        _HAS_DYNAMIC_CACHE = False
    HAS_QWEN2 = True
    HAS_QWEN3 = True
    HAS_GPT2 = True
except ImportError as _te:
    HAS_QWEN2 = False
    HAS_QWEN3 = False
    HAS_GPT2 = False
    _HAS_DYNAMIC_CACHE = False
    Qwen2RotaryEmbedding = None
    Qwen3_5TextRotaryEmbedding = None


# ── Session ────────────────────────────────────────────────────────────────────

@dataclass
class PipelineShard:
    session_id: str
    layer_start: int
    layer_end: int
    model_config: dict
    has_embedding: bool
    has_lm_head: bool
    hidden_size: int
    vocab_size: int
    ttl_sec: int
    created_ns: int
    # Poids reçus (name → np.ndarray float16)
    weight_arrays: Dict[str, np.ndarray] = field(default_factory=dict)
    # Slice PyTorch construit après réception des poids
    model_slice: Optional[Any] = None
    # Runtime de calcul actif (PyTorch legacy, MLX Velocity, vLLM futur).
    backend: Optional[Any] = None
    # KV cache (DynamicCache ou list of (k, v) tensors)
    kv_cache: Optional[Any] = None
    # Position courante dans la séquence (pour RoPE)
    seq_position: int = 0
    model_id: str = ""
    pool_id: str = ""
    last_decode_mode: str = ""
    weight_bytes: int = 0
    weights_loaded: int = 0
    build_ms: int = 0
    download_ms: int = 0
    last_forward_ms: int = 0
    last_used_ns: int = 0


class RuntimeBackend(Protocol):
    """Interface commune aux moteurs de calcul workers."""

    name: str

    def build(self) -> dict[str, Any]:
        ...

    def forward(self, data: bytes, session_id: str) -> bytes:
        ...

    def unload(self) -> None:
        ...

    def status(self) -> dict[str, Any]:
        ...

    def capabilities(self) -> dict[str, Any]:
        ...


class PyTorchBackend:
    """Backend legacy stable : conserve le comportement actuel."""

    name = "pytorch"

    def __init__(self, shard: PipelineShard, requested_backend: str = "pytorch", fallback_reason: str | None = None):
        self.shard = shard
        self.requested_backend = requested_backend
        self.fallback_reason = fallback_reason

    def build(self) -> dict[str, Any]:
        if not HAS_QWEN2:
            return {"ok": False, "error": "transformers Qwen2 non disponible"}
        t0 = time.perf_counter()
        try:
            self.shard.model_slice = _build_slice(self.shard)
            elapsed = int((time.perf_counter() - t0) * 1000)
            self.shard.build_ms = elapsed
            n_params = sum(p.numel() for p in self.shard.model_slice.parameters())
            print(f"[shard] build {self.shard.session_id[:16]}… {n_params:,} params en {elapsed}ms backend=pytorch")
            return {"ok": True, "params": n_params, "build_ms": elapsed, "runtime_backend": self.name}
        except Exception as e:
            return {"ok": False, "error": str(e), "runtime_backend": self.name}

    def forward(self, data: bytes, session_id: str) -> bytes:
        return _pytorch_pipeline_shard_forward(data, session_id)

    def unload(self) -> None:
        self.shard.model_slice = None
        self.shard.kv_cache = None
        self.shard.weight_arrays.clear()

    def status(self) -> dict[str, Any]:
        ready = self.shard.model_slice is not None and bool(self.shard.weights_loaded or self.shard.weight_arrays)
        return {
            "runtime_backend": self.name,
            "requested_runtime_backend": self.requested_backend,
            "runtime_fallback_reason": self.fallback_reason,
            "ready": ready,
            "attention_backend": getattr(self.shard.model_slice, "vryx_attention_backend", None) if self.shard.model_slice is not None else None,
            "batch_forward": True,
        }

    def capabilities(self) -> dict[str, Any]:
        return {
            "runtime_backend": self.name,
            "supports_mlx": False,
            "supports_vllm": False,
            "supports_q4_weights": False,
            "weight_quantization": getattr(self.shard, "weight_quantization", "fp16"),
            "attention_backend": getattr(self.shard.model_slice, "vryx_attention_backend", "pytorch"),
            "batch_forward": True,
            "q4_hidden_transport_supported": False,
        }


def _mlx_strict_no_fallback() -> bool:
    return os.environ.get("VRYX_MLX_STRICT", "0").lower() in ("1", "true", "yes")


def _select_backend(shard: PipelineShard, meta: dict[str, Any]) -> RuntimeBackend:
    # Priorité : env var du worker (capacité locale) > meta envoyé par le VPS
    worker_env_backend = os.environ.get("VRYX_RUNTIME_BACKEND", "").strip().lower()
    meta_backend = str(meta.get("runtime_backend") or "").strip().lower()
    requested = worker_env_backend or meta_backend or "pytorch"
    print(f"[backend] select: worker_env={worker_env_backend!r} meta={meta_backend!r} → {requested!r}")
    if requested == "mlx":
        try:
            from mlx_backend import MLXBackend
            backend = MLXBackend(shard)
            if backend.available:
                return backend
            strict = _mlx_strict_no_fallback() or os.environ.get(
                "VRYX_DISABLE_PYTORCH_FALLBACK", "0",
            ).lower() in ("1", "true", "yes")
            if strict:
                return backend
            return PyTorchBackend(shard, requested_backend="mlx", fallback_reason=backend.unavailable_reason)
        except Exception as e:
            strict = _mlx_strict_no_fallback() or os.environ.get(
                "VRYX_DISABLE_PYTORCH_FALLBACK", "0",
            ).lower() in ("1", "true", "yes")
            if strict:
                raise RuntimeError(f"mlx_strict: import ou initialisation MLX impossible ({e})") from e
            return PyTorchBackend(shard, requested_backend="mlx", fallback_reason=f"mlx_import_failed:{e}")
    if requested == "vllm":
        try:
            from vllm_backend import VLLMBackend
            return VLLMBackend(shard)
        except Exception as e:
            return PyTorchBackend(shard, requested_backend="vllm", fallback_reason=f"vllm_import_failed:{e}")
    return PyTorchBackend(shard)


_shards: Dict[str, PipelineShard] = {}
_mlx_lm_models: Dict[str, Any] = {}
_mlx_lm_tokenizers: Dict[str, Any] = {}
_mlx_lm_lock = threading.Lock()
_mlx_lm_stats: Dict[str, dict[str, Any]] = {}
_prefix_cache: Dict[str, dict[str, Any]] = {}
_prefix_cache_lock = threading.Lock()
HIDDEN_TRANSPORT = os.environ.get("VRYX_HIDDEN_TRANSPORT", "int8").lower()
PIPELINE_STREAM_MODE = os.environ.get("VRYX_PIPELINE_STREAM_MODE", "hot_session").lower()
WORKER_KV_CACHE = os.environ.get("VRYX_WORKER_KV_CACHE", "true").lower() not in ("0", "false", "no")
SAMPLING_TEMPERATURE = float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0.35"))
SAMPLING_TOP_P = float(os.environ.get("VRYX_SAMPLING_TOP_P", "0.75"))
SAMPLING_TOP_K = int(os.environ.get("VRYX_SAMPLING_TOP_K", "20"))
REPETITION_PENALTY = float(os.environ.get("VRYX_REPETITION_PENALTY", "1.18"))
HIDDEN_QUIC = os.environ.get("VRYX_HIDDEN_QUIC", "0").lower() in ("1", "true", "yes")
PREFIX_CACHE = os.environ.get("VRYX_PREFIX_CACHE", "0").lower() in ("1", "true", "yes")
SPECULATIVE_HEADS = os.environ.get("VRYX_SPECULATIVE_HEADS", "off").lower()
CONTINUOUS_BATCHING = os.environ.get("VRYX_CONTINUOUS_BATCHING", "0").lower() in ("1", "true", "yes")
CHUNKED_PREFILL = os.environ.get("VRYX_CHUNKED_PREFILL", "0").lower() in ("1", "true", "yes")
RING_ATTENTION = os.environ.get("VRYX_RING_ATTENTION", "0").lower() in ("1", "true", "yes")


def _now_ns() -> int:
    return time.time_ns()


def _worker_device() -> torch.device:
    forced = os.environ.get("VRYX_WORKER_DEVICE", "").strip().lower()
    if forced:
        return torch.device(forced)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _worker_dtype(device: torch.device, is_gpt2: bool) -> torch.dtype:
    if is_gpt2 or device.type == "cpu":
        return torch.float32
    return torch.float16


def _attention_backend(device: torch.device) -> str:
    if device.type == "cuda":
        try:
            if hasattr(torch.backends, "cuda") and torch.backends.cuda.flash_sdp_enabled():
                return "cuda_flash_attention_sdpa"
        except Exception:
            pass
        return "cuda_sdpa"
    if device.type == "mps":
        return "mac_mps_dev"
    return "cpu_debug"


def _quantize_hidden_int8(hidden_states: torch.Tensor) -> dict[str, Any]:
    hs = hidden_states.detach().float().cpu().numpy()
    max_abs = float(np.max(np.abs(hs))) if hs.size else 1.0
    scale = max(max_abs / 127.0, 1e-8)
    q = np.clip(np.round(hs / scale), -127, 127).astype(np.int8)
    return {
        "hidden_q_b64": base64.b64encode(q.tobytes()).decode(),
        "hidden_scale": scale,
        "hidden_zero_point": 0,
        "hidden_shape": list(hs.shape),
        "hidden_dtype": "int8",
    }


def _quantize_hidden_q4(hidden_states: torch.Tensor) -> dict[str, Any]:
    hs = hidden_states.detach().float().cpu().numpy()
    max_abs = float(np.max(np.abs(hs))) if hs.size else 1.0
    scale = max(max_abs / 7.0, 1e-8)
    q = np.clip(np.round(hs / scale), -7, 7).astype(np.int8).reshape(-1)
    n = q.size
    if n % 2:
        q = np.pad(q, (0, 1), mode="constant")
    nibbles = (q.astype(np.int16) + 8).astype(np.uint8)
    packed = (nibbles[0::2] & 0x0F) | ((nibbles[1::2] & 0x0F) << 4)
    return {
        "hidden_q4_b64": base64.b64encode(packed.tobytes()).decode(),
        "hidden_scale": scale,
        "hidden_zero_point": 0,
        "hidden_shape": list(hs.shape),
        "hidden_dtype": "q4",
        "hidden_q4_len": int(n),
    }


def _decode_hidden_payload(payload: dict[str, Any], shard: PipelineShard, device: torch.device, dtype: torch.dtype) -> torch.Tensor | None:
    if payload.get("hidden_q4_b64"):
        raw = base64.b64decode(payload.get("hidden_q4_b64", ""))
        shape = tuple(int(x) for x in payload.get("hidden_shape", []))
        scale = float(payload.get("hidden_scale") or 1.0)
        total = int(payload.get("hidden_q4_len") or np.prod(shape))
        packed = np.frombuffer(raw, dtype=np.uint8)
        lo = (packed & 0x0F).astype(np.int8) - 8
        hi = ((packed >> 4) & 0x0F).astype(np.int8) - 8
        q = np.empty(packed.size * 2, dtype=np.int8)
        q[0::2] = lo
        q[1::2] = hi
        q = q[:total].reshape(shape)
        hs = q.astype(np.float32) * scale
        return torch.from_numpy(hs).to(device=device, dtype=dtype)

    if payload.get("hidden_q_b64"):
        raw = base64.b64decode(payload.get("hidden_q_b64", ""))
        shape = tuple(int(x) for x in payload.get("hidden_shape", []))
        scale = float(payload.get("hidden_scale") or 1.0)
        q = np.frombuffer(raw, dtype=np.int8).reshape(shape)
        hs = q.astype(np.float32) * scale
        return torch.from_numpy(hs).to(device=device, dtype=dtype)

    if payload.get("hidden_fp16_b64"):
        raw = base64.b64decode(payload.get("hidden_fp16_b64", ""))
        shape = tuple(int(x) for x in payload.get("hidden_shape", []))
        hs = np.frombuffer(raw, dtype=np.float16).reshape(shape)
        return torch.from_numpy(hs).to(device=device, dtype=dtype)

    hidden_b64 = payload.get("hidden_b64", "")
    if not hidden_b64:
        return None
    hs_bytes = base64.b64decode(hidden_b64)
    hs_flat = np.frombuffer(hs_bytes, dtype=np.float32)
    seq_len_inferred = len(hs_flat) // shard.hidden_size
    hidden_states = torch.from_numpy(hs_flat)
    return hidden_states.reshape(1, seq_len_inferred, shard.hidden_size).to(device=device, dtype=dtype)


def _sample_next_token(logits: torch.Tensor, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    sampling = payload.get("sampling") if isinstance(payload.get("sampling"), dict) else {}
    temperature = float(sampling.get("temperature", SAMPLING_TEMPERATURE))
    top_p = float(sampling.get("top_p", SAMPLING_TOP_P))
    top_k = int(sampling.get("top_k", SAMPLING_TOP_K))
    repetition_penalty = float(sampling.get("repetition_penalty", REPETITION_PENALTY))
    history = payload.get("history_token_ids") or payload.get("token_ids") or []
    scores = logits.detach().float().squeeze(0).clone()

    if repetition_penalty and repetition_penalty > 1.0 and isinstance(history, list):
        for token_id in set(int(t) for t in history[-512:] if isinstance(t, int)):
            if 0 <= token_id < scores.numel():
                scores[token_id] = scores[token_id] / repetition_penalty if scores[token_id] > 0 else scores[token_id] * repetition_penalty

    if temperature <= 0:
        return int(torch.argmax(scores).item()), {
            "sampling_mode": "greedy",
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "repetition_penalty": repetition_penalty,
        }

    scores = scores / max(temperature, 1e-5)
    if top_k > 0 and top_k < scores.numel():
        values, indices = torch.topk(scores, top_k)
        filtered = torch.full_like(scores, float("-inf"))
        filtered.scatter_(0, indices, values)
        scores = filtered

    probs = torch.softmax(scores, dim=-1)
    if 0.0 < top_p < 1.0:
        sorted_probs, sorted_indices = torch.sort(probs, descending=True)
        cumulative = torch.cumsum(sorted_probs, dim=-1)
        remove = cumulative > top_p
        remove[0] = False
        sorted_probs = sorted_probs.masked_fill(remove, 0.0)
        total = sorted_probs.sum()
        if total > 0:
            sorted_probs = sorted_probs / total
            picked = sorted_indices[torch.multinomial(sorted_probs, 1)]
            return int(picked.item()), {
                "sampling_mode": "top_p",
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
                "repetition_penalty": repetition_penalty,
            }

    token_id = int(torch.multinomial(probs, 1).item())
    return token_id, {
        "sampling_mode": "multinomial",
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
        "repetition_penalty": repetition_penalty,
    }


def _debug_top_logits_torch(logits: torch.Tensor, k: int = 10) -> list[dict[str, float | int]]:
    if os.environ.get("VRYX_DEBUG_TOP_LOGITS", "0").lower() not in ("1", "true", "yes"):
        return []
    flat = logits.detach().float().reshape(-1).cpu()
    k = max(1, min(k, int(flat.numel())))
    values, indices = torch.topk(flat, k)
    return [{"id": int(i), "logit": float(v)} for i, v in zip(indices.tolist(), values.tolist())]


def _purge_expired() -> None:
    now = _now_ns()
    dead = [
        sid for sid, s in _shards.items()
        if now - s.created_ns > int(s.ttl_sec) * 1_000_000_000
    ]
    for sid in dead:
        s = _shards.pop(sid, None)
        if s and s.model_slice is not None:
            del s.model_slice
            s.model_slice = None
            s.kv_cache = None


def mlx_lm_direct_generate(raw: bytes) -> bytes:
    """Génération locale via mlx-lm officiel, sans shard custom VRYX."""
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

    model_id = str(payload.get("model_id") or os.environ.get("VRYX_WORKER_MODEL") or "Qwen/Qwen3.5-9B")
    prompt = str(payload.get("prompt") or "")
    if not prompt:
        return json.dumps({"ok": False, "error": "prompt manquant"}).encode()
    try:
        max_tokens = int(payload.get("max_new_tokens") or payload.get("max_tokens") or 64)
    except (TypeError, ValueError):
        max_tokens = 64
    max_tokens = max(1, min(4096, max_tokens))

    try:
        from mlx_lm import load, stream_generate
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"mlx_lm_unavailable:{type(exc).__name__}:{exc}"}).encode()

    load_ms = 0
    cache_hit = model_id in _mlx_lm_models
    with _mlx_lm_lock:
        cache_hit = model_id in _mlx_lm_models
        if not cache_hit:
            t_load = time.perf_counter()
            model, tokenizer = load(model_id)
            _mlx_lm_models[model_id] = model
            _mlx_lm_tokenizers[model_id] = tokenizer
            load_ms = int((time.perf_counter() - t_load) * 1000)
            _mlx_lm_stats[model_id] = {
                "loads": int((_mlx_lm_stats.get(model_id) or {}).get("loads") or 0) + 1,
                "last_load_ms": load_ms,
                "loaded_at_ms": int(time.time() * 1000),
            }
        model = _mlx_lm_models[model_id]
        tokenizer = _mlx_lm_tokenizers[model_id]

    chunks: list[str] = []
    token_count = 0
    first_token_ms: int | None = None
    t0 = time.perf_counter()
    try:
        token_events: list[dict[str, Any]] = []
        for response in stream_generate(model, tokenizer, prompt, max_tokens=max_tokens):
            if first_token_ms is None:
                first_token_ms = int((time.perf_counter() - t0) * 1000)
            token_count += 1
            piece = str(getattr(response, "text", "") or "")
            chunks.append(piece)
            token_events.append({
                "index": token_count,
                "text": piece,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            })
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "error": f"mlx_lm_generate_failed:{type(exc).__name__}:{exc}",
            "runtime_backend": "mlx_lm",
            "model_id": model_id,
            "load_ms": load_ms,
            "cache_hit": cache_hit,
            "cache_status": "hit" if cache_hit else "loaded",
        }, ensure_ascii=False).encode()

    generation_ms = max(1, int((time.perf_counter() - t0) * 1000))
    return json.dumps({
        "ok": True,
        "runtime_backend": "mlx_lm",
        "model_id": model_id,
        "text": "".join(chunks),
        "completion_tokens": token_count,
        "prompt_tokens": 0,
        "total_tokens": token_count,
        "load_ms": load_ms,
        "mlx_lm_load_ms": load_ms,
        "cache_hit": cache_hit,
        "cache_status": "hit" if cache_hit else "loaded",
        "resident_model": True,
        "model_cache_size": len(_mlx_lm_models),
        "generation_ms": generation_ms,
        "ttft_ms": first_token_ms,
        "token_events": token_events,
        "actual_tps": round(token_count * 1000.0 / generation_ms, 3) if generation_ms > 0 else 0,
        "decode_mode": "mlx_lm_direct_stream_generate",
    }, ensure_ascii=False).encode()


def pipeline_cache_save(meta_json: bytes) -> str:
    try:
        meta = json.loads(meta_json.decode("utf-8", errors="replace")) if meta_json else {}
    except Exception:
        meta = {}
    sid = str(meta.get("session_id") or "")
    prefix_hash = str(meta.get("prefix_hash") or "")
    if not PREFIX_CACHE:
        return json.dumps({"ok": True, "cache_saved": False, "cache_metadata_only": True, "reason": "prefix_cache_disabled"})
    if not sid or not prefix_hash:
        return json.dumps({"ok": False, "error": "session_id ou prefix_hash manquant"})
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue"})
    cache_copy = None
    cache_restorable = shard.kv_cache is not None
    if cache_restorable:
        try:
            cache_copy = copy.deepcopy(shard.kv_cache)
        except Exception as e:
            print(f"[shard] prefix cache metadata-only {sid[:12]}… deepcopy impossible: {e}")
            cache_restorable = False
    entry = {
        "session_id": sid,
        "prefix_hash": prefix_hash,
        "pool_id": shard.pool_id,
        "model_id": shard.model_id,
        "tokens_cached": int(meta.get("tokens_cached") or shard.seq_position or 0),
        "seq_position": shard.seq_position,
        "created_ns": _now_ns(),
        "metadata": meta,
        "cache_metadata_only": not cache_restorable,
        "kv_cache": cache_copy if cache_restorable else None,
    }
    with _prefix_cache_lock:
        _prefix_cache[prefix_hash] = entry
    return json.dumps({
        "ok": True,
        "cache_saved": True,
        "cache_restorable": cache_restorable,
        "cache_metadata_only": not cache_restorable,
        "prefix_hash": prefix_hash,
        "tokens_cached": entry["tokens_cached"],
        "seq_position": shard.seq_position,
    })


def pipeline_cache_load(meta_json: bytes) -> str:
    try:
        meta = json.loads(meta_json.decode("utf-8", errors="replace")) if meta_json else {}
    except Exception:
        meta = {}
    sid = str(meta.get("session_id") or "")
    prefix_hash = str(meta.get("prefix_hash") or "")
    shard = _shards.get(sid)
    if not PREFIX_CACHE:
        return json.dumps({"ok": True, "cache_hit": False, "cache_restored": False, "cache_metadata_only": True, "reason": "prefix_cache_disabled"})
    if shard is None or not prefix_hash:
        return json.dumps({"ok": False, "cache_hit": False, "cache_restored": False, "error": "session ou prefix_hash manquant"})
    with _prefix_cache_lock:
        entry = _prefix_cache.get(prefix_hash)
    if not entry:
        return json.dumps({"ok": True, "cache_hit": False, "cache_restored": False, "cache_metadata_only": True})
    if entry.get("kv_cache") is not None:
        shard.kv_cache = copy.deepcopy(entry.get("kv_cache"))
        shard.seq_position = int(entry.get("seq_position") or entry.get("tokens_cached") or shard.seq_position)
        return json.dumps({
            "ok": True,
            "cache_hit": True,
            "cache_restored": True,
            "cache_metadata_only": False,
            "prefix_hash": prefix_hash,
            "tokens_cached": entry.get("tokens_cached"),
            "seq_position": shard.seq_position,
        })
    return json.dumps({
        "ok": True,
        "cache_hit": True,
        "cache_restored": False,
        "cache_metadata_only": True,
        "prefix_hash": prefix_hash,
        "tokens_cached": entry.get("tokens_cached"),
    })


def pipeline_cache_status(meta_json: bytes = b"") -> str:
    try:
        meta = json.loads(meta_json.decode("utf-8", errors="replace")) if meta_json else {}
    except Exception:
        meta = {}
    only_hash = str(meta.get("prefix_hash") or "")
    with _prefix_cache_lock:
        entries = [
            {
                "prefix_hash": key,
                "tokens_cached": value.get("tokens_cached"),
                "cache_restorable": value.get("kv_cache") is not None,
                "cache_metadata_only": value.get("kv_cache") is None,
                "age_sec": int((_now_ns() - int(value.get("created_ns") or _now_ns())) / 1_000_000_000),
            }
            for key, value in _prefix_cache.items()
            if not only_hash or key == only_hash
        ]
    return json.dumps({"ok": True, "prefix_cache": PREFIX_CACHE, "entries": entries, "count": len(entries)})


# ── Ancien runtime (compatibilité descendante) ─────────────────────────────────

@dataclass
class EphemeralShardSession:
    session_id: str
    layer_start: int
    layer_end: int
    created_ns: int
    ttl_sec: int
    model_tag: str = ""
    kv_cache: Any = None


_sessions: dict = {}


def shard_init(session_id: str, ttl_sec: int, layer_start: int, layer_end: int, model_tag: str) -> str:
    _purge_expired()
    _sessions[session_id] = EphemeralShardSession(
        session_id=session_id,
        layer_start=layer_start,
        layer_end=layer_end,
        created_ns=_now_ns(),
        ttl_sec=max(1, min(ttl_sec, 3600)),
        model_tag=model_tag or "",
    )
    return f"ok init {session_id} layers {layer_start}-{layer_end}"


def shard_unload(session_id: str) -> str:
    _sessions.pop(session_id, None)
    s = _shards.pop(session_id, None)
    if s and s.model_slice is not None:
        del s.model_slice
    return f"ok unload {session_id}"


def ephemeral_layer_forward(activation_bytes: bytes, layer_id: int, session_id: str) -> tuple[bytes, int]:
    """Fallback shard forward — retourne les bytes tels quels avec compute fictif."""
    t0 = time.perf_counter()
    if not activation_bytes:
        out = np.zeros(1, dtype=np.float16).tobytes()
    else:
        try:
            arr = np.frombuffer(activation_bytes, dtype=np.float16).copy()
            out = (arr * 1.0).tobytes()  # identité
        except Exception:
            out = activation_bytes
    compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
    return out, compute_ms


# ── Pipeline Parallelism ────────────────────────────────────────────────────────

class _Qwen3_5WorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.config = config
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.embed_tokens = torch.nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = torch.nn.ModuleList([
            Qwen3_5DecoderLayer(config, layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.norm = Qwen3_5RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        if Qwen3_5TextRotaryEmbedding is not None:
            self.rotary_emb = Qwen3_5TextRotaryEmbedding(config=config)
        else:
            self.rotary_emb = None

class _Qwen2WorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.config = config
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.embed_tokens = torch.nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = torch.nn.ModuleList([
            Qwen2DecoderLayer(config, layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.norm = Qwen2RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        # Rotary embeddings (transformers 5.x : RoPE pré-calculé hors des couches)
        if Qwen2RotaryEmbedding is not None:
            self.rotary_emb = Qwen2RotaryEmbedding(config=config)
        else:
            self.rotary_emb = None


class _GPT2WorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.wte = torch.nn.Embedding(config.vocab_size, config.n_embd)
            self.wpe = torch.nn.Embedding(config.n_positions, config.n_embd)
            self.drop = torch.nn.Dropout(config.embd_pdrop)
        self.h = torch.nn.ModuleList([
            GPT2Block(config, layer_idx=layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.ln_f = torch.nn.LayerNorm(config.n_embd, eps=config.layer_norm_epsilon)
            self.lm_head = torch.nn.Linear(config.n_embd, config.vocab_size, bias=False)


def _build_slice(shard: PipelineShard) -> object:
    """Construit le module PyTorch depuis les poids reçus."""
    cfg_d = shard.model_config
    model_type = cfg_d.get("model_type", "gpt2")
    is_gpt2_model = model_type == "gpt2"
    device = _worker_device()
    dtype = _worker_dtype(device, is_gpt2_model)
    state_dict = {k: torch.from_numpy(v).to(dtype=dtype)
                  for k, v in shard.weight_arrays.items()}

    if model_type == "gpt2" and HAS_GPT2:
        config = GPT2Config(
            n_embd=cfg_d.get("n_embd", 768),
            n_layer=cfg_d.get("n_layer", 12),
            n_head=cfg_d.get("n_head", 12),
            n_positions=cfg_d.get("n_positions", 1024),
            vocab_size=cfg_d.get("vocab_size", 50257),
            layer_norm_epsilon=float(cfg_d.get("layer_norm_epsilon", 1e-5)),
            embd_pdrop=float(cfg_d.get("embd_pdrop", 0.1)),
            resid_pdrop=0.0,
            attn_pdrop=0.0,
        )
        model = _GPT2WorkerSlice(
            config, shard.layer_start, shard.layer_end,
            shard.has_embedding, shard.has_lm_head,
        )
    elif model_type in ("qwen3", "qwen3_5", "qwen3_5_text") and HAS_QWEN3:
        config = Qwen3_5TextConfig(**cfg_d)
        model = _Qwen3_5WorkerSlice(
            config, shard.layer_start, shard.layer_end,
            shard.has_embedding, shard.has_lm_head,
        )
    elif model_type == "qwen2" and HAS_QWEN2:
        config = Qwen2Config(
            hidden_size=cfg_d.get("hidden_size", 896),
            num_hidden_layers=cfg_d.get("num_hidden_layers_total", 24),
            num_attention_heads=cfg_d.get("num_attention_heads", 14),
            num_key_value_heads=cfg_d.get("num_key_value_heads", 2),
            intermediate_size=cfg_d.get("intermediate_size", 4864),
            vocab_size=cfg_d.get("vocab_size", 151936),
            rms_norm_eps=float(cfg_d.get("rms_norm_eps", 1e-6)),
            rope_theta=float(cfg_d.get("rope_theta", 1000000.0)),
            max_position_embeddings=int(cfg_d.get("max_position_embeddings", 32768)),
        )
        model = _Qwen2WorkerSlice(
            config, shard.layer_start, shard.layer_end,
            shard.has_embedding, shard.has_lm_head,
        )
    else:
        raise RuntimeError("Aucune architecture transformers disponible.")

    missing, _ = model.load_state_dict(state_dict, strict=False)
    if missing:
        print(f"[!] Shard {shard.session_id}: {len(missing)} poids manquants ({missing[:3]}…)")
    shard.weight_arrays.clear()

    model.to(device=device, dtype=dtype)
    model.eval()
    model.vryx_device = device
    model.vryx_dtype = dtype
    model.vryx_attention_backend = _attention_backend(device)
    return model


def _is_gpt2(shard: PipelineShard) -> bool:
    return shard.model_config.get("model_type", "gpt2") == "gpt2"


# ── API principale ─────────────────────────────────────────────────────────────

def pipeline_shard_init(meta_json: bytes) -> str:
    """
    Reçoit vryx.shard.init.
    Si `download_url` est présent, télécharge les poids directement depuis le VPS (HTTPS),
    sans passer par le relay P2P (évite la limite de 1GB des circuits relay libp2p).
    """
    _purge_expired()
    meta = json.loads(meta_json.decode("utf-8", errors="replace"))
    sid = str(meta.get("session_id") or "")
    if not sid:
        return '{"ok": false, "error": "session_id manquant"}'
    cfg = meta.get("model_config") or {}
    hidden = int(cfg.get("hidden_size", cfg.get("n_embd", 896)))
    vocab = int(cfg.get("vocab_size", 151936))
    _shards[sid] = PipelineShard(
        session_id=sid,
        layer_start=int(meta.get("layer_start", 0)),
        layer_end=int(meta.get("layer_end", 7)),
        model_config=cfg,
        has_embedding=bool(meta.get("has_embedding", False)),
        has_lm_head=bool(meta.get("has_lm_head", False)),
        hidden_size=hidden,
        vocab_size=vocab,
        ttl_sec=int(meta.get("ttl_sec", 600)),
        created_ns=_now_ns(),
        model_id=str(meta.get("model_id") or cfg.get("_model_id") or ""),
        pool_id=str(meta.get("pool_id") or ""),
        last_used_ns=_now_ns(),
    )
    setattr(_shards[sid], "hidden_transport", str(meta.get("hidden_transport") or HIDDEN_TRANSPORT))
    setattr(_shards[sid], "weight_quantization", str(meta.get("weight_quantization") or "fp16"))
    setattr(_shards[sid], "runtime_backend", str(meta.get("runtime_backend") or "pytorch"))
    setattr(_shards[sid], "supports_q4_weights", bool(meta.get("supports_q4_weights", False)))
    setattr(_shards[sid], "supports_mlx", bool(meta.get("supports_mlx", False)))
    setattr(_shards[sid], "supports_vllm", bool(meta.get("supports_vllm", False)))
    setattr(_shards[sid], "pipeline_stream_mode", str(meta.get("pipeline_stream_mode") or PIPELINE_STREAM_MODE))
    setattr(_shards[sid], "worker_kv_cache", bool(meta.get("worker_kv_cache", WORKER_KV_CACHE)))
    setattr(_shards[sid], "hidden_quic", bool(meta.get("hidden_quic", HIDDEN_QUIC)))
    setattr(_shards[sid], "prefix_cache", bool(meta.get("prefix_cache", PREFIX_CACHE)))
    setattr(_shards[sid], "speculative_heads", str(meta.get("speculative_heads") or SPECULATIVE_HEADS))
    setattr(_shards[sid], "continuous_batching", bool(meta.get("continuous_batching", CONTINUOUS_BATCHING)))
    setattr(_shards[sid], "chunked_prefill", bool(meta.get("chunked_prefill", CHUNKED_PREFILL)))
    setattr(_shards[sid], "ring_attention", bool(meta.get("ring_attention", RING_ATTENTION)))
    _shards[sid].backend = _select_backend(_shards[sid], meta)
    setattr(_shards[sid], "loading", bool(str(meta.get("download_url") or "").strip()))
    setattr(_shards[sid], "build_ready", False)
    n_layers = _shards[sid].layer_end - _shards[sid].layer_start + 1
    print(f"[shard] init {sid[:16]}… layers {_shards[sid].layer_start}-{_shards[sid].layer_end}"
          f" embed={_shards[sid].has_embedding} lm_head={_shards[sid].has_lm_head}")

    # Téléchargement direct des poids depuis le VPS (HTTPS) si URL fournie
    download_url = str(meta.get("download_url") or "").strip()
    if download_url:
        if bool(meta.get("async_load", True)):
            async_meta = dict(meta)
            async_meta["async_load"] = False

            def _load_in_background() -> None:
                result = pipeline_shard_init(json.dumps(async_meta).encode("utf-8"))
                print(f"[shard] async load terminé {sid[:16]}… {result[:240]}")

            threading.Thread(target=_load_in_background, daemon=True).start()
            return json.dumps({"ok": True, "session_id": sid, "num_layers": n_layers, "loading": True})

        try:
            import ssl as _ssl
            _ctx = _ssl.create_default_context()
            _ctx.check_hostname = False
            _ctx.verify_mode = _ssl.CERT_NONE
            print(f"[shard] Téléchargement manifeste depuis {download_url}")
            t0 = time.perf_counter()
            req = urllib.request.Request(download_url, method="GET")
            with urllib.request.urlopen(req, timeout=MANIFEST_FETCH_TIMEOUT_SEC, context=_ctx) as resp:
                raw = resp.read()
            shard_data = json.loads(raw.decode("utf-8", errors="replace"))

            shard = _shards[sid]
            n_weights = 0

            # Format binaire compact (manifest .json + .bin séparé) avec download chunké + retry
            bin_url = shard_data.get("binary_url")
            weights_index = shard_data.get("weights_index") or []
            if bin_url and weights_index:
                expected = int(shard_data.get("binary_total_bytes", 0))
                shard.weight_bytes = expected
                print(f"[shard] Téléchargement binaire depuis {bin_url} ({expected / 1e6:.1f} MB)")

                # Download direct vers SSD + memmap : évite bytearray -> bytes -> copies RAM.
                cache_dir = os.environ.get("VRYX_WORKER_SHARD_CACHE_DIR", "/tmp/vryx-worker-shards")
                os.makedirs(cache_dir, exist_ok=True)
                model_cache_key = "".join(
                    ch if ch.isalnum() or ch in ("-", "_") else "_"
                    for ch in f"{shard.model_id or shard.model_config.get('model_type', 'model')}-"
                              f"{shard.layer_start}-{shard.layer_end}-"
                              f"emb{int(shard.has_embedding)}-head{int(shard.has_lm_head)}-"
                              f"{expected}"
                )
                bin_local_path = os.path.join(cache_dir, f"{model_cache_key}.bin")
                bytes_read = os.path.getsize(bin_local_path) if os.path.exists(bin_local_path) else 0
                if expected and bytes_read > expected:
                    os.remove(bin_local_path)
                    bytes_read = 0
                max_retries = 5
                if not (expected and bytes_read >= expected):
                    for attempt in range(max_retries):
                        try:
                            req_bin = urllib.request.Request(bin_url, method="GET")
                            if bytes_read > 0:
                                req_bin.add_header("Range", f"bytes={bytes_read}-")
                            with urllib.request.urlopen(req_bin, timeout=SHARD_BINARY_FETCH_TIMEOUT_SEC, context=_ctx) as resp_bin:
                                mode = "ab" if bytes_read > 0 else "wb"
                                with open(bin_local_path, mode) as out_bin:
                                    while True:
                                        chunk = resp_bin.read(8 * 1024 * 1024)  # 8 MB par chunk
                                        if not chunk:
                                            break
                                        out_bin.write(chunk)
                                        bytes_read += len(chunk)
                            if expected and bytes_read >= expected:
                                break
                            if not expected:
                                break
                            print(f"[shard] Reprise download (lu {bytes_read}/{expected})…")
                        except Exception as ex:
                            if attempt == max_retries - 1:
                                raise
                            print(f"[shard] Erreur download (tentative {attempt+1}) : {ex} — retry…")
                            time.sleep(2.0)
                else:
                    print(f"[shard] Binaire local déjà complet : {bin_local_path}")

                if expected and os.path.getsize(bin_local_path) < expected:
                    raise RuntimeError(f"Download incomplet : {os.path.getsize(bin_local_path)}/{expected}")

                for entry in weights_index:
                    name = entry["name"]
                    shape = tuple(int(x) for x in entry["shape"])
                    dtype = np.dtype(entry["dtype"])
                    off = int(entry["offset"])
                    nbytes = int(entry["nbytes"])
                    arr = np.memmap(bin_local_path, dtype=dtype, mode="r", offset=off, shape=shape)
                    shard.weight_arrays[name] = arr
                    n_weights += 1
                setattr(shard, "weight_file_path", bin_local_path)
                setattr(shard, "weight_load_mode", "memmap")
            else:
                # Compatibilité descendante : ancien format JSON+base64
                weights_meta = shard_data.get("weights") or {}
                for param_name, w in weights_meta.items():
                    try:
                        arr_bytes = base64.b64decode(w["b64"])
                        shape = tuple(int(x) for x in w["shape"])
                        dtype = np.dtype(w["dtype"])
                        arr = np.frombuffer(arr_bytes, dtype=dtype).reshape(shape).copy()
                        shard.weight_arrays[param_name] = arr
                        n_weights += 1
                    except Exception as e:
                        print(f"[shard] Erreur param {param_name} : {e}")

            elapsed = int((time.perf_counter() - t0) * 1000)
            shard.download_ms = elapsed
            shard.weights_loaded = n_weights
            print(f"[shard] Téléchargement OK : {n_weights} poids en {elapsed}ms")

            # Build immédiat
            build_res = json.loads(pipeline_shard_build(sid))
            if build_res.get("ok"):
                setattr(shard, "loading", False)
                setattr(shard, "build_ready", True)
                return json.dumps({"ok": True, "session_id": sid, "num_layers": n_layers,
                                   "weights_loaded": n_weights, "download_ms": elapsed})
            else:
                setattr(shard, "loading", False)
                return json.dumps({"ok": False, "session_id": sid,
                                   "error": f"Build échoué : {build_res.get('error')}"})
        except Exception as e:
            try:
                setattr(_shards.get(sid), "loading", False)
            except Exception:
                pass
            print(f"[shard] Échec téléchargement {download_url} : {e}")
            return json.dumps({"ok": False, "session_id": sid, "error": f"Téléchargement échoué : {e}"})

    return json.dumps({"ok": True, "session_id": sid, "num_layers": n_layers})


def pipeline_shard_load(load_json: bytes) -> str:
    """Reçoit vryx.shard.load : accumule un paramètre (numpy float16)."""
    meta = json.loads(load_json.decode("utf-8", errors="replace"))
    sid = str(meta.get("session_id") or "")
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue"})
    param_name = str(meta.get("param_name", ""))
    shape = tuple(int(x) for x in meta.get("shape", []))
    dtype_str = str(meta.get("dtype", "float16"))
    data_b64 = meta.get("data_b64", "")
    raw = base64.b64decode(data_b64)
    dtype = np.dtype(dtype_str)
    arr = np.frombuffer(raw, dtype=dtype).reshape(shape).copy()
    shard.weight_arrays[param_name] = arr
    shard.weights_loaded = len(shard.weight_arrays)
    shard.weight_bytes = sum(a.nbytes for a in shard.weight_arrays.values())
    return json.dumps({"ok": True, "param": param_name, "shape": list(shape)})


def pipeline_shard_build(sid: str) -> str:
    """Construit le slice via le backend sélectionné."""
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": "session inconnue"})
    if getattr(shard, "building", False):
        return json.dumps({"ok": False, "error": "build déjà en cours"})
    setattr(shard, "building", True)
    if shard.backend is None:
        shard.backend = _select_backend(shard, {"runtime_backend": getattr(shard, "runtime_backend", "pytorch")})
    try:
        result = shard.backend.build()
        if not result.get("ok") and getattr(shard.backend, "name", "pytorch") != "pytorch":
            reason = str(result.get("error") or "runtime_build_failed")
            if os.environ.get("VRYX_DISABLE_PYTORCH_FALLBACK", "0").lower() in ("1", "true", "yes"):
                print(f"[backend] fallback PyTorch interdit : {reason}")
                result["runtime_fallback_disabled"] = True
                result["runtime_fallback_reason"] = reason
                return json.dumps(result)
            print(f"[backend] fallback {getattr(shard.backend, 'name', 'unknown')} → pytorch : {reason}")
            shard.backend = PyTorchBackend(shard, requested_backend=getattr(shard, "runtime_backend", "mlx"), fallback_reason=reason)
            result = shard.backend.build()
            result["runtime_fallback_reason"] = reason
        if result.get("ok"):
            setattr(shard, "build_ready", True)
        return json.dumps(result)
    finally:
        setattr(shard, "building", False)


def _merge_batch_item_payload(batch_payload: dict[str, Any], item: dict[str, Any], shard_session_id: str) -> dict[str, Any]:
    item_payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    merged = {
        k: v
        for k, v in batch_payload.items()
        if k not in ("batch_items", "batching")
    }
    merged.update(item_payload)
    merged["session_id"] = str(item_payload.get("session_id") or item.get("session_id") or shard_session_id)
    merged["request_id"] = str(item_payload.get("request_id") or item.get("request_id") or merged["session_id"])
    return merged


def _pipeline_shard_forward_batch(payload: dict[str, Any], session_id: str) -> bytes:
    batch_items = payload.get("batch_items")
    if not isinstance(batch_items, list) or not batch_items:
        return json.dumps({"ok": False, "error": "batch_items vide"}).encode()
    shard_session_id = str(payload.get("session_id") or session_id)
    t0 = time.perf_counter()
    responses: list[dict[str, Any]] = []
    for item in batch_items:
        if not isinstance(item, dict):
            responses.append({"ok": False, "error": "batch item invalide"})
            continue
        item_payload = _merge_batch_item_payload(payload, item, shard_session_id)
        request_id = str(item_payload.get("request_id") or item_payload.get("session_id") or "")
        try:
            raw = pipeline_shard_forward(json.dumps(item_payload, ensure_ascii=False).encode("utf-8"), shard_session_id)
            response = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception as exc:
            response = {"ok": False, "error": f"batch_item_forward:{type(exc).__name__}:{exc}"}
        response["request_id"] = request_id
        response.setdefault("session_id", item_payload.get("session_id") or shard_session_id)
        responses.append(response)
    batch_meta = payload.get("batching") if isinstance(payload.get("batching"), dict) else {}
    elapsed = max(1, int((time.perf_counter() - t0) * 1000))
    return json.dumps({
        "ok": all(r.get("ok", True) is not False for r in responses),
        "session_id": shard_session_id,
        "batch_items": responses,
        "batching": {
            **batch_meta,
            "enabled": True,
            "batch_size": len(responses),
            "decode_batch_ms": elapsed,
            "worker_batch_forward": True,
            "worker_batch_mode": "sequential_stateful_fallback",
        },
    }).encode()


def pipeline_shard_forward(data: bytes, session_id: str) -> bytes:
    try:
        payload = json.loads(data.decode("utf-8", errors="replace"))
    except Exception:
        payload = {}
    sid = payload.get("session_id", session_id) or session_id
    if isinstance(payload.get("batch_items"), list):
        return _pipeline_shard_forward_batch(payload, sid)
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue. Relancer shard.init+load."}).encode()
    ready_timeout = max(600.0, float(os.environ.get("VRYX_SHARD_READY_TIMEOUT_SEC", "600")))
    deadline = time.time() + ready_timeout
    while getattr(shard, "loading", False) or getattr(shard, "building", False):
        if time.time() >= deadline:
            return json.dumps({
                "ok": False,
                "error": f"shard {sid[:16]} pas prêt après {int(ready_timeout)}s",
                "session_id": sid,
                "loading": bool(getattr(shard, "loading", False)),
                "building": bool(getattr(shard, "building", False)),
            }).encode()
        time.sleep(0.25)
        shard = _shards.get(sid)
        if shard is None:
            return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue pendant préparation"}).encode()
    if shard.backend is None:
        shard.backend = _select_backend(shard, {"runtime_backend": getattr(shard, "runtime_backend", "pytorch")})
    if not getattr(shard, "build_ready", False) and getattr(shard, "weights_loaded", 0) > 0:
        build_result = json.loads(pipeline_shard_build(sid))
        if not build_result.get("ok"):
            return json.dumps({
                "ok": False,
                "error": f"Build échoué avant forward : {build_result.get('error')}",
                "session_id": sid,
            }).encode()
    try:
        return shard.backend.forward(data, session_id)
    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        print(f"[backend] forward exception {sid[:16]} backend={getattr(shard.backend, 'name', '?')} : {exc}\n{tb}")
        return json.dumps({
            "ok": False,
            "error": f"forward_exception:{type(exc).__name__}:{exc}",
            "session_id": sid,
            "runtime_backend": getattr(shard.backend, "name", "unknown"),
        }).encode()


def _pytorch_pipeline_shard_forward(data: bytes, session_id: str) -> bytes:
    """
    Exécute le forward sur la tranche de couches.

    Entrée (worker 1 — has_embedding) : JSON {"session_id", "token_ids", "step"}
    Entrée (workers 2+) : JSON {"session_id", "hidden_b64", "seq_pos", "step"}

    Sortie (dernier worker — has_lm_head) : JSON {"next_token_id", "session_id"}
    Sortie (workers intermédiaires) : JSON {"hidden_b64", "seq_pos", "step", "session_id"}
    """
    t0 = time.perf_counter()
    try:
        payload = json.loads(data.decode("utf-8", errors="replace"))
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

    sid = payload.get("session_id", session_id) or session_id
    shard = _shards.get(sid)
    request_id = str(payload.get("request_id") or "default")

    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue. Relancer shard.init+load."}).encode()
    shard.last_used_ns = _now_ns()
    kv_caches = getattr(shard, "_request_kv_caches", None)
    if kv_caches is None:
        kv_caches = {}
        setattr(shard, "_request_kv_caches", kv_caches)
    if request_id != "default":
        shard.kv_cache = kv_caches.get(request_id)

    # Construire le modèle si pas encore fait
    if shard.model_slice is None:
        build_result = pipeline_shard_build(sid)
        br = json.loads(build_result)
        if not br.get("ok"):
            return json.dumps({"ok": False, "error": f"Build échoué : {br.get('error')}"}).encode()

    model = shard.model_slice
    device = getattr(model, "vryx_device", _worker_device())
    dtype = getattr(model, "vryx_dtype", _worker_dtype(device, _is_gpt2(shard)))
    step = int(payload.get("step", 0))
    seq_pos = int(payload.get("seq_pos", 0))
    use_kv_cache = bool(payload.get("use_kv_cache", getattr(shard, "worker_kv_cache", WORKER_KV_CACHE)))
    requested_decode_mode = str(payload.get("decode_mode") or ("prefill_full_context" if step == 0 else "full_context_fallback"))
    stateful_required = bool(payload.get("stateful_required") or requested_decode_mode == "single_token_stateful")
    if step == 0:
        shard.kv_cache = None
        if request_id != "default":
            kv_caches.pop(request_id, None)

    with torch.no_grad():
        is_gpt2 = _is_gpt2(shard)

        # ── Obtenir hidden_states ──────────────────────────────────────────────
        if shard.has_embedding and "token_ids" in payload:
            token_ids = torch.tensor(payload["token_ids"], dtype=torch.long, device=device)
            if is_gpt2:
                pos = torch.arange(seq_pos, seq_pos + len(token_ids), dtype=torch.long, device=device)
                tok_emb = model.wte(token_ids).to(dtype)
                pos_emb = model.wpe(pos).to(dtype)
                hidden_states = (tok_emb + pos_emb).unsqueeze(0)
            else:
                hidden_states = model.embed_tokens(token_ids).to(dtype).unsqueeze(0)
            current_seq_len = len(token_ids)
        else:
            hidden_states = _decode_hidden_payload(payload, shard, device, dtype)
            if hidden_states is None:
                return json.dumps({"ok": False, "error": "hidden state manquant"}).encode()
            if hidden_states.dim() == 2:
                hidden_states = hidden_states.unsqueeze(0)
            current_seq_len = int(hidden_states.shape[1])

        if step > 0 and use_kv_cache and requested_decode_mode == "single_token_stateful" and current_seq_len != 1:
            return json.dumps({
                "ok": False,
                "error": f"decode stateful invalide : seq_len={current_seq_len}, attendu=1",
                "session_id": sid,
                "step": step,
                "seq_pos": seq_pos,
                "decode_mode": "full_context_fallback",
            }).encode()
        if step > 0 and stateful_required and use_kv_cache and shard.kv_cache is None:
            return json.dumps({
                "ok": False,
                "error": "KV cache stateful manquant : refus du full prefill fallback",
                "session_id": sid,
                "step": step,
                "seq_pos": seq_pos,
                "decode_mode": "single_token_stateful",
                "kv_cache": False,
            }).encode()
        decode_mode = (
            "prefill_full_context"
            if step == 0
            else ("single_token_stateful" if use_kv_cache and current_seq_len == 1 else "full_context_fallback")
        )
        shard.last_decode_mode = decode_mode

        # ── Masque causal additif (obligatoire pour attention décodeur) ───────
        seq_len_for_mask = hidden_states.shape[1]
        if use_kv_cache and step > 0:
            # En décodage incrémental, les anciens tokens sont déjà dans le KV cache local du shard.
            causal_mask = torch.zeros(
                (1, 1, seq_len_for_mask, seq_pos + seq_len_for_mask),
                dtype=hidden_states.dtype,
                device=device,
            )
        else:
            causal_mask = torch.full(
                (seq_len_for_mask, seq_len_for_mask), float("-inf"),
                dtype=hidden_states.dtype,
                device=device,
            )
            causal_mask = torch.triu(causal_mask, diagonal=1)
            causal_mask = causal_mask.unsqueeze(0).unsqueeze(0)  # (1, 1, seq, seq)

        # ── Position embeddings (Qwen2 transformers 5.x : RoPE pré-calculé) ───
        position_embeddings = None
        position_ids = None
        if not is_gpt2:
            position_ids = torch.arange(seq_pos, seq_pos + current_seq_len, dtype=torch.long, device=device).unsqueeze(0)
            if model.rotary_emb is not None:
                position_embeddings = model.rotary_emb(hidden_states, position_ids)

        # ── Passe à travers les couches ────────────────────────────────────────
        layers = model.h if is_gpt2 else model.layers
        next_cache = None
        if use_kv_cache and not is_gpt2 and _HAS_DYNAMIC_CACHE and shard.kv_cache is None:
            try:
                shard.kv_cache = DynamicCache(config=getattr(model, "config", None))
            except Exception:
                shard.kv_cache = None
                use_kv_cache = False

        for layer in layers:
            if is_gpt2:
                out = layer(hidden_states, attention_mask=causal_mask)
                if isinstance(out, torch.Tensor):
                    hidden_states = out
                else:
                    hidden_states = out[0]
            else:
                kwargs = {
                    "attention_mask": causal_mask,
                    "position_ids": position_ids,
                    "use_cache": use_kv_cache,
                }
                if position_embeddings is not None:
                    kwargs["position_embeddings"] = position_embeddings
                if use_kv_cache and shard.kv_cache is not None:
                    kwargs["past_key_values"] = shard.kv_cache
                    try:
                        kwargs["cache_position"] = torch.arange(seq_pos, seq_pos + current_seq_len, dtype=torch.long, device=device)
                    except Exception:
                        pass
                try:
                    layer_out = layer(hidden_states, **kwargs)
                except Exception as cache_error:
                    if not use_kv_cache:
                        raise
                    if step > 0:
                        return json.dumps({
                            "ok": False,
                            "error": f"KV cache invalide au step {step}: {cache_error}",
                            "session_id": sid,
                            "step": step,
                            "seq_pos": seq_pos,
                        }).encode()
                    print(f"[shard] KV cache désactivé pour {sid[:12]}… fallback legacy: {cache_error}")
                    shard.kv_cache = None
                    use_kv_cache = False
                    kwargs.pop("past_key_values", None)
                    kwargs.pop("cache_position", None)
                    kwargs["use_cache"] = False
                    layer_out = layer(hidden_states, **kwargs)
                if isinstance(layer_out, torch.Tensor):
                    hidden_states = layer_out
                else:
                    hidden_states = layer_out[0]
                    if use_kv_cache and len(layer_out) > 1:
                        next_cache = layer_out[1]

        if use_kv_cache and next_cache is not None:
            shard.kv_cache = next_cache
            if request_id != "default":
                kv_caches[request_id] = next_cache

        # Réassurer la dim batch pour l'extraction du dernier token
        if hidden_states.dim() == 2:
            # (seq_len, hidden_size) → (1, seq_len, hidden_size)
            hidden_states = hidden_states.unsqueeze(0)

        # seq_pos est une position de token globale, pas un compteur de hops.
        # Tous les shards doivent garder la même position pour un même token.
        out_seq_pos = seq_pos
        shard.seq_position = seq_pos + current_seq_len
        compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
        shard.last_forward_ms = compute_ms

        # ── Sortie ─────────────────────────────────────────────────────────────
        if shard.has_lm_head:
            # Dernier worker : LM head → next_token_id
            last_hidden = hidden_states[0, -1, :]  # (hidden_size,)
            if is_gpt2:
                last_normed = model.ln_f(last_hidden.unsqueeze(0))
                logits = model.lm_head(last_normed)
            else:
                last_normed = model.norm(last_hidden.unsqueeze(0))
                logits = model.lm_head(last_normed)
            next_token_id, sampling_info = _sample_next_token(logits, payload)
            speculative_method = str(payload.get("speculative_heads") or getattr(shard, "speculative_heads", SPECULATIVE_HEADS)).lower()
            candidate_token_ids = [next_token_id]
            accepted_token_count = 1
            speculative_available = False
            print(f"[shard] lm_head {sid[:12]}… step={step} → token={next_token_id} ({compute_ms}ms)")
            return json.dumps({
                "ok": True,
                "next_token_id": next_token_id,
                "candidate_token_ids": candidate_token_ids,
                "accepted_token_count": accepted_token_count,
                "speculative_method": speculative_method,
                "speculative_available": speculative_available,
                "verify_ms": 0,
                "sampling": sampling_info,
                "session_id": sid,
                "request_id": request_id,
                "compute_time_ms": compute_ms,
                "kv_cache": bool(use_kv_cache),
                "decode_mode": decode_mode,
                "attention_backend": getattr(model, "vryx_attention_backend", "unknown"),
                "hidden_quic": bool(payload.get("hidden_quic", getattr(shard, "hidden_quic", HIDDEN_QUIC))),
                "quic_used": False,
                "debug_top_logits": _debug_top_logits_torch(logits),
            }).encode()
        else:
            # Worker intermédiaire : q4/int8 par requête, avec int8 comme chemin stable.
            transport = str(payload.get("hidden_transport") or getattr(shard, "hidden_transport", HIDDEN_TRANSPORT)).lower()
            hidden_payload: dict[str, Any]
            fallback_reason = None
            if transport == "q4":
                hidden_payload = _quantize_hidden_q4(hidden_states)
            elif transport == "int8":
                hidden_payload = _quantize_hidden_int8(hidden_states)
            elif transport == "fp16":
                hs_out = hidden_states.detach().to(torch.float16).cpu().numpy()
                hidden_payload = {
                    "hidden_fp16_b64": base64.b64encode(hs_out.tobytes()).decode(),
                    "hidden_shape": list(hs_out.shape),
                    "hidden_dtype": "fp16",
                }
            else:
                fallback_reason = f"transport_{transport}_unsupported"
                transport = "int8"
                hidden_payload = _quantize_hidden_int8(hidden_states)
            print(f"[shard] forward {sid[:12]}… step={step} seq_pos={out_seq_pos} ({compute_ms}ms)")
            out = {
                "ok": True,
                "seq_pos": out_seq_pos,
                "step": step,
                "session_id": sid,
                "request_id": request_id,
                "history_token_ids": payload.get("history_token_ids") or payload.get("token_ids") or [],
                "stop_token_ids": payload.get("stop_token_ids") or [],
                "sampling": payload.get("sampling") or {},
                "compute_time_ms": compute_ms,
                "hidden_transport": transport,
                "effective_quantization": transport,
                "quantization_fallback_reason": fallback_reason,
                "kv_cache": bool(use_kv_cache),
                "decode_mode": decode_mode,
                "attention_backend": getattr(model, "vryx_attention_backend", "unknown"),
                "hidden_quic": bool(payload.get("hidden_quic", getattr(shard, "hidden_quic", HIDDEN_QUIC))),
                "quic_used": False,
            }
            out.update(hidden_payload)
            return json.dumps(out).encode()

    # Unreachable but satisfies type checker
    return json.dumps({"ok": False, "error": "unknown"}).encode()


def pipeline_shard_status(status_json: bytes = b"") -> str:
    """Retourne les shards résidents sur ce worker pour le Pool Manager."""
    _purge_expired()
    try:
        meta = json.loads(status_json.decode("utf-8", errors="replace")) if status_json else {}
    except Exception:
        meta = {}
    only_session = str(meta.get("session_id") or "")
    now = _now_ns()
    shards = []
    for sid, shard in _shards.items():
        if only_session and sid != only_session:
            continue
        backend_status = shard.backend.status() if shard.backend is not None else {}
        backend_caps = shard.backend.capabilities() if shard.backend is not None else {}
        runtime_backend = str(backend_status.get("runtime_backend") or getattr(shard, "runtime_backend", "pytorch"))
        ready = bool(backend_status.get("ready")) if backend_status else shard.model_slice is not None and bool(shard.weights_loaded or shard.weight_arrays)
        shards.append({
            "session_id": sid,
            "model_id": shard.model_id,
            "pool_id": shard.pool_id,
            "layer_start": shard.layer_start,
            "layer_end": shard.layer_end,
            "num_layers": max(0, shard.layer_end - shard.layer_start + 1),
            "has_embedding": shard.has_embedding,
            "has_lm_head": shard.has_lm_head,
            "weights_loaded": shard.weights_loaded or len(shard.weight_arrays),
            "weight_bytes": shard.weight_bytes or sum(a.nbytes for a in shard.weight_arrays.values()),
            "resident_weight_bytes": shard.weight_bytes or sum(a.nbytes for a in shard.weight_arrays.values()),
            "memory_mode": "mlx_strict" if os.environ.get("VRYX_MLX_STRICT", "0").lower() in ("1", "true", "yes") else "standard",
            "mlx_strict": os.environ.get("VRYX_MLX_STRICT", "0").lower() in ("1", "true", "yes"),
            "fallback_disabled": os.environ.get("VRYX_DISABLE_PYTORCH_FALLBACK", "0").lower() in ("1", "true", "yes"),
            "built": ready,
            "ready": ready,
            "resident_vram": ready,
            "weight_load_mode": getattr(shard, "weight_load_mode", "memory"),
            "download_ms": shard.download_ms,
            "build_ms": shard.build_ms,
            "last_forward_ms": shard.last_forward_ms,
            "hidden_transport": getattr(shard, "hidden_transport", HIDDEN_TRANSPORT),
            "q4_supported": bool(backend_caps.get("q4_hidden_transport_supported", False)),
            "int8_supported": True,
            "weight_quantization": getattr(shard, "weight_quantization", "fp16"),
            "runtime_backend": runtime_backend,
            "requested_runtime_backend": backend_status.get("requested_runtime_backend"),
            "runtime_fallback_reason": backend_status.get("runtime_fallback_reason"),
            "supports_q4_weights": bool(backend_caps.get("supports_q4_weights", getattr(shard, "supports_q4_weights", False))),
            "supports_mlx": bool(backend_caps.get("supports_mlx", getattr(shard, "supports_mlx", False))),
            "supports_vllm": bool(backend_caps.get("supports_vllm", getattr(shard, "supports_vllm", False))),
            "pipeline_stream_mode": getattr(shard, "pipeline_stream_mode", PIPELINE_STREAM_MODE),
            "kv_cache_ready": shard.kv_cache is not None,
            "worker_kv_cache": bool(getattr(shard, "worker_kv_cache", WORKER_KV_CACHE)),
            "last_decode_mode": shard.last_decode_mode,
            "attention_backend": backend_status.get("attention_backend") or (getattr(shard.model_slice, "vryx_attention_backend", None) if shard.model_slice is not None else None),
            "flash_attention": bool(backend_caps.get("flash_attention", False)),
            "linear_attn_ready": bool(backend_caps.get("linear_attn_ready", False) or backend_status.get("linear_attn_ready", False)),
            "state_bytes": int(backend_status.get("state_bytes") or 0),
            "state_pages": backend_status.get("state_pages") or backend_caps.get("state_paging"),
            "paged_kv_cache": bool(backend_caps.get("paged_kv_cache", False)),
            "hidden_quic": bool(getattr(shard, "hidden_quic", HIDDEN_QUIC)),
            "quic_available": False,
            "prefix_cache": bool(getattr(shard, "prefix_cache", PREFIX_CACHE)),
            "speculative_heads": getattr(shard, "speculative_heads", SPECULATIVE_HEADS),
            "speculative_available": False,
            "continuous_batching": bool(getattr(shard, "continuous_batching", CONTINUOUS_BATCHING)),
            "batch_forward": bool(backend_caps.get("batch_forward", backend_status.get("batch_forward", True))),
            "chunked_prefill": bool(getattr(shard, "chunked_prefill", CHUNKED_PREFILL)),
            "ring_attention": bool(getattr(shard, "ring_attention", RING_ATTENTION)),
            "age_sec": int((now - shard.created_ns) / 1_000_000_000),
            "idle_sec": int((now - (shard.last_used_ns or shard.created_ns)) / 1_000_000_000),
            "ttl_sec": shard.ttl_sec,
        })
    return json.dumps({
        "ok": True,
        "worker_generated_text": False,
        "shards": shards,
        "count": len(shards),
        "persistent_relay": os.environ.get("VRYX_PERSISTENT_RELAY", "0").lower() in ("1", "true", "yes"),
        "pipeline_overlap": os.environ.get("VRYX_PIPELINE_OVERLAP", "0").lower() in ("1", "true", "yes"),
    })


def worker_text_relay(payload_bytes: bytes, routing_path: list) -> tuple[str, int]:
    """Fallback minimal — retourne un message d'erreur propre si aucune session active."""
    t0 = time.perf_counter()
    compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
    msg = json.dumps({
        "ok": False,
        "error": "Aucune session de couches active sur ce worker. Lancer shard.init + shard.load.",
        "worker_generated_text": False,
    })
    return msg, compute_ms
