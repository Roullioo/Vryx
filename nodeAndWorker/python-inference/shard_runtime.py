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
import concurrent.futures
import json
import os
import copy
import queue
import ssl
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
        from transformers.models.qwen3_5_moe.configuration_qwen3_5_moe import Qwen3_5MoeTextConfig
        from transformers.models.qwen3_5_moe.modeling_qwen3_5_moe import Qwen3_5MoeDecoderLayer, Qwen3_5MoeRMSNorm
        HAS_QWEN3_5_MOE = True
    except ImportError:
        Qwen3_5MoeTextConfig = None
        Qwen3_5MoeDecoderLayer = None
        Qwen3_5MoeRMSNorm = None
        HAS_QWEN3_5_MOE = False
    try:
        from transformers.models.qwen2.modeling_qwen2 import Qwen2RotaryEmbedding
    except ImportError:
        Qwen2RotaryEmbedding = None
    try:
        from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5TextRotaryEmbedding
    except ImportError:
        Qwen3_5TextRotaryEmbedding = None
    try:
        from transformers import LlamaConfig
        from transformers.models.llama.modeling_llama import LlamaDecoderLayer, LlamaRMSNorm
        try:
            from transformers.models.llama.modeling_llama import LlamaRotaryEmbedding
        except ImportError:
            LlamaRotaryEmbedding = None
        HAS_LLAMA = True
    except ImportError:
        LlamaConfig = None
        LlamaDecoderLayer = None
        LlamaRMSNorm = None
        LlamaRotaryEmbedding = None
        HAS_LLAMA = False
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
    HAS_QWEN3_5_MOE = False
    HAS_GPT2 = False
    HAS_LLAMA = False
    _HAS_DYNAMIC_CACHE = False
    Qwen2RotaryEmbedding = None
    Qwen3_5TextRotaryEmbedding = None
    Qwen3_5MoeTextConfig = None
    Qwen3_5MoeDecoderLayer = None
    Qwen3_5MoeRMSNorm = None
    LlamaConfig = None
    LlamaDecoderLayer = None
    LlamaRMSNorm = None
    LlamaRotaryEmbedding = None


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
    if worker_env_backend == "mlx_lm" and meta_backend == "mlx":
        requested = "mlx"
    print(f"[backend] select: worker_env={worker_env_backend!r} meta={meta_backend!r} → {requested!r}")
    if requested == "mlx":
        if str(getattr(shard, "weight_load_mode", "") or "").lower() == "gguf_ranges":
            try:
                from gguf_mlx_backend import GGUFLazyMLXBackend
                backend = GGUFLazyMLXBackend(shard)
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
                    raise RuntimeError(f"mlx_strict: initialisation GGUF/MLX impossible ({e})") from e
                return PyTorchBackend(shard, requested_backend="mlx", fallback_reason=f"gguf_mlx_import_failed:{e}")
        if str(shard.model_config.get("model_type") or "").lower() == "llama" and os.environ.get(
            "VRYX_ENABLE_LLAMA_MLX_SHARD", "0",
        ).lower() not in ("1", "true", "yes"):
            return PyTorchBackend(shard, requested_backend="mlx", fallback_reason="mlx_llama_shard_backend_pending")
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
_mlx_lm_generation_locks: Dict[str, threading.Lock] = {}
_mlx_lm_stats: Dict[str, dict[str, Any]] = {}


def _https_context_for_worker_callbacks() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        try:
            return ssl.create_default_context()
        except Exception:
            return ssl._create_unverified_context()


_WORKER_CALLBACK_SSL_CONTEXT = _https_context_for_worker_callbacks()
_prefix_cache: Dict[str, dict[str, Any]] = {}
_prefix_cache_lock = threading.Lock()
HIDDEN_TRANSPORT = os.environ.get("VRYX_HIDDEN_TRANSPORT", "int8").lower()
PIPELINE_STREAM_MODE = os.environ.get("VRYX_PIPELINE_STREAM_MODE", "hot_session").lower()
WORKER_KV_CACHE = os.environ.get("VRYX_WORKER_KV_CACHE", "true").lower() not in ("0", "false", "no")
SAMPLING_TEMPERATURE = float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0"))
SAMPLING_TOP_P = float(os.environ.get("VRYX_SAMPLING_TOP_P", "0.65"))
SAMPLING_TOP_K = int(os.environ.get("VRYX_SAMPLING_TOP_K", "20"))
REPETITION_PENALTY = float(os.environ.get("VRYX_REPETITION_PENALTY", "1.08"))
HIDDEN_QUIC = os.environ.get("VRYX_HIDDEN_QUIC", "0").lower() in ("1", "true", "yes")
PREFIX_CACHE = os.environ.get("VRYX_PREFIX_CACHE", "0").lower() in ("1", "true", "yes")
SPECULATIVE_HEADS = os.environ.get("VRYX_SPECULATIVE_HEADS", "off").lower()
CONTINUOUS_BATCHING = os.environ.get("VRYX_CONTINUOUS_BATCHING", "0").lower() in ("1", "true", "yes")
CHUNKED_PREFILL = os.environ.get("VRYX_CHUNKED_PREFILL", "0").lower() in ("1", "true", "yes")
RING_ATTENTION = os.environ.get("VRYX_RING_ATTENTION", "0").lower() in ("1", "true", "yes")
MLX_LM_BUSY_TIMEOUT_SEC = max(0.05, float(os.environ.get("VRYX_MLX_LM_BUSY_TIMEOUT_SEC", "0.25")))
def _env_int(name: str, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _env_float(name: str, default: float, minimum: float = 1.0, maximum: float | None = None) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


MLX_LM_MAX_TOKENS = _env_int("VRYX_MLX_LM_MAX_TOKENS", 32768, minimum=1, maximum=32768)
MLX_LM_MAX_SECONDS = _env_float("VRYX_MLX_LM_MAX_SECONDS", 240.0, minimum=1.0, maximum=900.0)
MLX_LM_MAX_KV_SIZE = _env_int("VRYX_MLX_LM_MAX_KV_SIZE", 4096, minimum=256, maximum=32768)
MLX_LM_PREFILL_STEP_SIZE = _env_int("VRYX_MLX_LM_PREFILL_STEP_SIZE", 1024, minimum=128, maximum=8192)
MLX_LM_STREAM_CHUNK_TOKENS = _env_int("VRYX_MLX_LM_STREAM_CHUNK_TOKENS", 12, minimum=1, maximum=128)
MLX_LM_STREAM_CHUNK_MS = _env_int("VRYX_MLX_LM_STREAM_CHUNK_MS", 45, minimum=0, maximum=500)
LLAMA_CPP_URL = os.environ.get("VRYX_LLAMA_CPP_URL", os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
LLAMA_CPP_MODEL = os.environ.get("VRYX_LLAMA_CPP_MODEL", os.environ.get("OLLAMA_MODEL", "vryx-llama2-70b-q4")).strip()
LLAMA_CPP_TIMEOUT_SEC = _env_float("VRYX_LLAMA_CPP_TIMEOUT_SEC", 900.0, minimum=5.0, maximum=3600.0)
LLAMA_CPP_WARMUP_ENABLED = os.environ.get("VRYX_LLAMA_CPP_WARMUP", "1").strip().lower() not in ("0", "false", "no", "off")
LLAMA_CPP_WARMUP_TOKENS = _env_int("VRYX_LLAMA_CPP_WARMUP_TOKENS", 1, minimum=1, maximum=16)
LLAMA_CPP_WARMUP_KEEP_ALIVE = os.environ.get("VRYX_LLAMA_CPP_KEEP_ALIVE", "24h") or "24h"
_llama_cpp_warmup_started = False


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


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).lower() in ("1", "true", "yes", "on")


def _requires_distributed_shards(model_id: str) -> bool:
    if "Qwen3.6-35B" in model_id or model_id == "Qwen/Qwen3.6-35B-A3B":
        return False
    if _env_truthy("VRYX_LLAMA_CPP_DIRECT"):
        return False
    return (
        _env_truthy("VRYX_WORKER_SHARD_ONLY")
        or _env_truthy("VRYX_EXPECT_MODEL_SHARDS_ONLY")
        or _env_truthy("VRYX_DISABLE_MLX_LM_DIRECT")
    )


def _resolve_mlx_load_model_id(model_id: str, payload: dict[str, Any]) -> str:
    explicit = str(payload.get("load_model_id") or "").strip()
    if explicit:
        return explicit
    if model_id == "Qwen/Qwen3.6-35B-A3B" or "Qwen3.6-35B" in model_id:
        return "mlx-community/Qwen3.6-35B-A3B-4bit"
    env_model = os.environ.get("VRYX_MLX_LM_MODEL_ID", "").strip()
    if env_model and (env_model != model_id or ("70b" in model_id.lower())):
        return env_model
    return model_id


def mlx_lm_preload(raw: bytes) -> bytes:
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()
    model_id = str(payload.get("model_id") or os.environ.get("VRYX_WORKER_MODEL") or "Qwen/Qwen3.5-9B")
    if _requires_distributed_shards(model_id):
        return json.dumps({
            "ok": False,
            "error": "mlx_lm_preload_disabled: worker en mode shard",
            "model_id": model_id,
        }, ensure_ascii=False).encode()
    load_model_id = _resolve_mlx_load_model_id(model_id, payload)
    try:
        from mlx_lm import load
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"mlx_lm_unavailable:{type(exc).__name__}:{exc}"}).encode()
    cache_hit = load_model_id in _mlx_lm_models
    load_ms = 0
    with _mlx_lm_lock:
        cache_hit = load_model_id in _mlx_lm_models
        if not cache_hit:
            t_load = time.perf_counter()
            model, tokenizer = load(load_model_id)
            _mlx_lm_models[load_model_id] = model
            _mlx_lm_tokenizers[load_model_id] = tokenizer
            load_ms = int((time.perf_counter() - t_load) * 1000)
            _mlx_lm_stats[load_model_id] = {
                "loads": int((_mlx_lm_stats.get(load_model_id) or {}).get("loads") or 0) + 1,
                "last_load_ms": load_ms,
                "loaded_at_ms": int(time.time() * 1000),
                "requested_model_id": model_id,
            }
        _mlx_lm_generation_locks.setdefault(load_model_id, threading.Lock())
    return json.dumps({
        "ok": True,
        "runtime_backend": "mlx_lm",
        "model_id": model_id,
        "load_model_id": load_model_id,
        "resident_model": True,
        "cache_hit": cache_hit,
        "cache_status": "hit" if cache_hit else "loaded",
        "load_ms": load_ms,
    }, ensure_ascii=False).encode()


def _llama_cpp_warmup_worker(model_id: str) -> None:
    if not model_id:
        return
    attempts = _env_int("VRYX_LLAMA_CPP_WARMUP_ATTEMPTS", 8, minimum=1, maximum=60)
    delay_sec = _env_float("VRYX_LLAMA_CPP_WARMUP_RETRY_SEC", 2.5, minimum=0.2, maximum=60.0)
    options = {
        "num_predict": LLAMA_CPP_WARMUP_TOKENS,
        "temperature": 0,
        "num_ctx": _env_int("VRYX_LLAMA_CPP_NUM_CTX", 2048, minimum=512, maximum=32768),
        "num_batch": _env_int("VRYX_LLAMA_CPP_NUM_BATCH", 512, minimum=32, maximum=4096),
        "num_gpu": int(os.environ.get("VRYX_LLAMA_CPP_NUM_GPU", "999") or "999"),
    }
    payload = {
        "model": model_id,
        "stream": False,
        "think": False,
        "keep_alive": LLAMA_CPP_WARMUP_KEEP_ALIVE,
        "prompt": "Vryx warmup. Réponds OK.",
        "options": options,
    }
    for attempt in range(1, attempts + 1):
        try:
            t0 = time.perf_counter()
            req = urllib.request.Request(
                f"{LLAMA_CPP_URL}/api/generate",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=min(120.0, LLAMA_CPP_TIMEOUT_SEC)) as resp:
                resp.read()
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            print(f"[llama.cpp] warmup OK model={model_id} attempt={attempt} elapsed_ms={elapsed_ms}", flush=True)
            return
        except Exception as exc:
            if attempt == attempts:
                print(f"[llama.cpp] warmup failed model={model_id} attempts={attempts}: {type(exc).__name__}:{exc}", flush=True)
                return
            time.sleep(delay_sec)


def start_llama_cpp_warmup_once(model_id: str | None = None) -> None:
    global _llama_cpp_warmup_started
    if not LLAMA_CPP_WARMUP_ENABLED:
        return
    target = str(model_id or LLAMA_CPP_MODEL or os.environ.get("VRYX_WORKER_MODEL") or "").strip()
    if not target:
        return
    if _llama_cpp_warmup_started:
        return
    _llama_cpp_warmup_started = True
    threading.Thread(target=_llama_cpp_warmup_worker, args=(target,), daemon=True).start()


def llama_cpp_direct_generate(raw: bytes) -> bytes:
    """Génération locale via Ollama/llama.cpp GGUF natif."""
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

    prompt = str(payload.get("prompt") or "")
    if not prompt:
        return json.dumps({"ok": False, "error": "prompt manquant"}).encode()
    model_id = str(payload.get("model_id") or os.environ.get("VRYX_WORKER_MODEL") or "meta-llama/Llama-2-70b-hf")
    load_model_id = str(payload.get("load_model_id") or LLAMA_CPP_MODEL or model_id).strip()
    try:
        max_tokens = int(payload.get("max_new_tokens") or payload.get("max_tokens") or 64)
    except (TypeError, ValueError):
        max_tokens = 64
    max_tokens = max(1, min(32768, max_tokens))
    try:
        temperature = float(payload.get("temperature", SAMPLING_TEMPERATURE))
    except (TypeError, ValueError):
        temperature = SAMPLING_TEMPERATURE
    try:
        top_p = float(payload.get("top_p", SAMPLING_TOP_P))
    except (TypeError, ValueError):
        top_p = SAMPLING_TOP_P
    try:
        top_k = int(payload.get("top_k", SAMPLING_TOP_K))
    except (TypeError, ValueError):
        top_k = SAMPLING_TOP_K

    system_prompt = str(payload.get("system_prompt") or os.environ.get("VRYX_CHAT_SYSTEM_PROMPT") or (
        "Tu es l'assistant Vryx. Réponds dans la langue de l'utilisateur. "
        f"Le moteur local est llama.cpp/Ollama avec le modèle {load_model_id}. "
        "Si l'utilisateur demande ton modèle, réponds honnêtement."
    ))
    try:
        num_ctx = int(payload.get("num_ctx") or os.environ.get("VRYX_LLAMA_CPP_NUM_CTX", "2048") or "2048")
    except (TypeError, ValueError):
        num_ctx = 2048
    try:
        num_batch = int(payload.get("num_batch") or os.environ.get("VRYX_LLAMA_CPP_NUM_BATCH", "512") or "512")
    except (TypeError, ValueError):
        num_batch = 512
    keep_alive = str(payload.get("keep_alive") or os.environ.get("VRYX_LLAMA_CPP_KEEP_ALIVE", "24h") or "24h")
    use_generate = str(payload.get("use_generate", os.environ.get("VRYX_LLAMA_CPP_USE_GENERATE", "1"))).strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    stream_metrics = str(payload.get("stream_metrics", os.environ.get("VRYX_LLAMA_CPP_STREAM_METRICS", "1"))).strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    options = {
        "num_predict": max_tokens,
        "temperature": max(0.0, min(2.0, temperature)),
        "top_p": max(0.0, min(1.0, top_p)),
        "top_k": max(0, min(200, top_k)),
        "num_ctx": max(512, min(32768, num_ctx)),
        "num_batch": max(32, min(4096, num_batch)),
        "num_gpu": int(os.environ.get("VRYX_LLAMA_CPP_NUM_GPU", "999") or "999"),
    }
    body = {
        "model": load_model_id,
        "stream": bool(stream_metrics),
        "think": False,
        "keep_alive": keep_alive,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "options": options,
    }
    stream_id = str(payload.get("stream_id") or "")
    stream_secret = str(payload.get("stream_secret") or "")
    stream_callback_url = str(payload.get("stream_callback_url") or "")
    stream_callback_queue: queue.Queue[tuple[str | None, int, int]] = queue.Queue(maxsize=4096)
    stream_callback_done = threading.Event()
    stream_callback_worker: threading.Thread | None = None

    def _post_stream_token(piece: str, index: int, elapsed_ms: int, timeout_sec: float = 1.25) -> None:
        try:
            body = json.dumps({
                "stream_id": stream_id,
                "event": "token",
                "token": piece,
                "index": index,
                "elapsed_ms": elapsed_ms,
                "runtime_backend": "llama_cpp",
            }, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                stream_callback_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {stream_secret}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_sec, context=_WORKER_CALLBACK_SSL_CONTEXT) as resp:
                resp.read(128)
        except Exception:
            pass

    def _stream_callback_loop() -> None:
        while True:
            try:
                piece, index, elapsed_ms = stream_callback_queue.get(timeout=0.2)
            except Exception:
                if stream_callback_done.is_set():
                    return
                continue
            try:
                if piece is None:
                    return
                _post_stream_token(piece, index, elapsed_ms)
            finally:
                try:
                    stream_callback_queue.task_done()
                except Exception:
                    pass

    def _emit_stream_token(piece: str, index: int, elapsed_ms: int) -> None:
        nonlocal stream_callback_worker
        if not piece or not stream_id or not stream_secret or not stream_callback_url:
            return
        if stream_callback_worker is None:
            stream_callback_worker = threading.Thread(target=_stream_callback_loop, daemon=True)
            stream_callback_worker.start()
        try:
            stream_callback_queue.put_nowait((piece, index, elapsed_ms))
        except Exception:
            # Never let the live UI stream slow down model decoding.
            pass

    def _drain_stream_callbacks(timeout_sec: float = 1.0) -> None:
        if stream_callback_worker is None:
            return
        deadline = time.perf_counter() + timeout_sec
        while time.perf_counter() < deadline:
            if stream_callback_queue.unfinished_tasks == 0:
                break
            time.sleep(0.01)
        stream_callback_done.set()
        try:
            stream_callback_queue.put_nowait((None, 0, 0))
        except Exception:
            pass
        try:
            stream_callback_worker.join(timeout=0.2)
        except Exception:
            pass

    def _read_json_response(req: urllib.request.Request) -> tuple[dict[str, Any], int | None]:
        with urllib.request.urlopen(req, timeout=LLAMA_CPP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace") or "{}"), None

    def _read_stream_response(req: urllib.request.Request, mode: str, started_at: float) -> tuple[dict[str, Any], int | None]:
        pieces: list[str] = []
        final: dict[str, Any] = {}
        ttft_ms: int | None = None
        stream_index = 0
        with urllib.request.urlopen(req, timeout=LLAMA_CPP_TIMEOUT_SEC) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                final = item
                if mode == "chat":
                    msg = item.get("message") if isinstance(item.get("message"), dict) else {}
                    piece = str(msg.get("content") or "")
                else:
                    piece = str(item.get("response") or "")
                if piece:
                    if ttft_ms is None:
                        ttft_ms = max(1, int((time.perf_counter() - started_at) * 1000))
                    stream_index += 1
                    pieces.append(piece)
                    _emit_stream_token(piece, stream_index, int((time.perf_counter() - started_at) * 1000))
                if item.get("done") is True:
                    break
        text = "".join(pieces)
        if mode == "chat":
            final["message"] = {"content": text}
        else:
            final["response"] = text
        return final, ttft_ms

    t0 = time.perf_counter()
    ttft_ms: int | None = None
    try:
        if use_generate:
            generate_body = {
                "model": load_model_id,
                "stream": bool(stream_metrics),
                "think": False,
                "keep_alive": keep_alive,
                "prompt": f"{system_prompt}\n\nUtilisateur: {prompt}\nAssistant:",
                "options": options,
            }
            req = urllib.request.Request(
                f"{LLAMA_CPP_URL}/api/generate",
                data=json.dumps(generate_body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            if stream_metrics:
                data, ttft_ms = _read_stream_response(req, "generate", t0)
            else:
                data, ttft_ms = _read_json_response(req)
        else:
            req = urllib.request.Request(
                f"{LLAMA_CPP_URL}/api/chat",
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            if stream_metrics:
                data, ttft_ms = _read_stream_response(req, "chat", t0)
            else:
                data, ttft_ms = _read_json_response(req)
    except Exception as exc:
        _drain_stream_callbacks()
        return json.dumps({
            "ok": False,
            "error": f"llama_cpp_generate_failed:{type(exc).__name__}:{exc}",
            "runtime_backend": "llama_cpp",
            "model_id": model_id,
            "load_model_id": load_model_id,
        }, ensure_ascii=False).encode()
    generation_ms = max(1, int((time.perf_counter() - t0) * 1000))
    msg = data.get("message") if isinstance(data.get("message"), dict) else {}
    text = str(msg.get("content") or data.get("response") or "")

    if not text.strip() and use_generate:
        chat_body = {**body, "stream": bool(stream_metrics)}
        chat_req = urllib.request.Request(
            f"{LLAMA_CPP_URL}/api/chat",
            data=json.dumps(chat_body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            if stream_metrics:
                chat_data, chat_ttft_ms = _read_stream_response(chat_req, "chat", t0)
                if ttft_ms is None:
                    ttft_ms = chat_ttft_ms
            else:
                chat_data, _ = _read_json_response(chat_req)
            chat_msg = chat_data.get("message") if isinstance(chat_data.get("message"), dict) else {}
            chat_text = str(chat_msg.get("content") or chat_data.get("response") or "")
            if chat_text.strip():
                data = chat_data
                text = chat_text
        except Exception:
            pass

    if not text.strip():
        fallback_body = {
            "model": load_model_id,
            "stream": bool(stream_metrics),
            "think": False,
            "keep_alive": keep_alive,
            "prompt": f"{system_prompt}\n\nUtilisateur: {prompt}\nAssistant:",
            "options": options,
        }
        fallback_req = urllib.request.Request(
            f"{LLAMA_CPP_URL}/api/generate",
            data=json.dumps(fallback_body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            if stream_metrics:
                fallback_data, fallback_ttft_ms = _read_stream_response(fallback_req, "generate", t0)
                if ttft_ms is None:
                    ttft_ms = fallback_ttft_ms
            else:
                fallback_data, _ = _read_json_response(fallback_req)
            fallback_text = str(fallback_data.get("response") or "")
            if fallback_text.strip():
                data = fallback_data
                text = fallback_text
        except Exception:
            pass

    if not text.strip():
        _drain_stream_callbacks()
        return json.dumps({
            "ok": False,
            "error": "llama_cpp_empty_content",
            "runtime_backend": "llama_cpp",
            "model_id": model_id,
            "load_model_id": load_model_id,
            "hint": "Le backend local a renvoye une reponse vide. VRYX refuse d'afficher le champ thinking comme sortie utilisateur.",
            "done_reason": str(data.get("done_reason") or ("stop" if data.get("done") else "unknown")),
        }, ensure_ascii=False).encode()

    prompt_tokens = int(data.get("prompt_eval_count") or 0)
    completion_tokens = int(data.get("eval_count") or 0)
    total_duration_ns = data.get("total_duration")
    eval_duration_ns = data.get("eval_duration")
    load_duration_ns = data.get("load_duration")
    prompt_eval_duration_ns = data.get("prompt_eval_duration")
    if isinstance(total_duration_ns, (int, float)) and total_duration_ns > 0:
        generation_ms = max(1, int(total_duration_ns / 1_000_000))
    eval_ms = int(eval_duration_ns / 1_000_000) if isinstance(eval_duration_ns, (int, float)) else 0
    actual_tps = round(completion_tokens * 1000.0 / max(1, eval_ms or generation_ms), 3) if completion_tokens else 0.0
    _drain_stream_callbacks()
    return json.dumps({
        "ok": True,
        "runtime_backend": "llama_cpp",
        "model_id": model_id,
        "load_model_id": load_model_id,
        "text": text.strip(),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "generation_ms": generation_ms,
        "eval_ms": eval_ms,
        "load_ms": int(load_duration_ns / 1_000_000) if isinstance(load_duration_ns, (int, float)) else 0,
        "prompt_eval_ms": int(prompt_eval_duration_ns / 1_000_000) if isinstance(prompt_eval_duration_ns, (int, float)) else 0,
        "ttft_ms": int(ttft_ms or 0),
        "actual_tps": actual_tps,
        "decode_mode": "llama_cpp_ollama_generate",
        "requested_max_tokens": max_tokens,
        "effective_max_tokens": max_tokens,
        "stop_reason": str(data.get("done_reason") or ("stop" if data.get("done") else "unknown")),
        "sampling": options,
    }, ensure_ascii=False).encode()


def mlx_lm_direct_generate(raw: bytes) -> bytes:
    """Génération locale via mlx-lm officiel, sans shard custom VRYX."""
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

    model_id = str(payload.get("model_id") or os.environ.get("VRYX_WORKER_MODEL") or "Qwen/Qwen3.5-9B")
    if _requires_distributed_shards(model_id):
        return json.dumps({
            "ok": False,
            "error": "mlx_lm_direct_disabled: ce modele est reserve au pipeline distribue shard-only",
            "runtime_backend": "sharded_pipeline",
            "requested_runtime_backend": "mlx_lm",
            "model_id": model_id,
            "shard_only": True,
            "hint": "Envoyer des requetes vryx.shard.init/decode avec les couches attribuees au worker, pas un chargement direct du modele complet.",
        }, ensure_ascii=False).encode()
    load_model_id = _resolve_mlx_load_model_id(model_id, payload)
    prompt = str(payload.get("prompt") or "")
    if not prompt:
        return json.dumps({"ok": False, "error": "prompt manquant"}).encode()
    system_prompt = str(
        payload.get("system_prompt")
        or os.environ.get("VRYX_CHAT_SYSTEM_PROMPT")
        or (
            "Tu es l'assistant Vryx, une interface de chat connectée au réseau de calcul Vryx. "
            f"Le modèle LLM actuellement utilisé est {model_id}"
            f"{f' chargé via {load_model_id}' if load_model_id and load_model_id != model_id else ''}. "
            "Si l'utilisateur demande qui tu es, quel LLM te fait tourner, ton cerveau ou ton modèle, "
            "réponds honnêtement avec ce modèle et précise que Vryx est l'interface/réseau, pas le nom du LLM. "
            "Réponds en français par défaut. Si une information manque ou est incertaine, dis-le clairement. "
            "N'invente pas de dates, de noms, de sources ou de faits. Évite les répétitions."
        )
    )
    try:
        max_tokens = int(payload.get("max_new_tokens") or payload.get("max_tokens") or 64)
    except (TypeError, ValueError):
        max_tokens = 64
    requested_max_tokens = max_tokens
    max_tokens = max(1, min(MLX_LM_MAX_TOKENS, max_tokens))
    stream_id = str(payload.get("stream_id") or "")
    stream_secret = str(payload.get("stream_secret") or "")
    stream_callback_url = str(payload.get("stream_callback_url") or "")
    stream_callback_queue: queue.Queue[tuple[str | None, int, int]] = queue.Queue(maxsize=4096)
    stream_callback_done = threading.Event()
    stream_callback_worker: threading.Thread | None = None

    def _post_stream_token(piece: str, index: int, elapsed_ms: int, timeout_sec: float = 2.0) -> None:
        try:
            body = json.dumps({
                "stream_id": stream_id,
                "event": "token",
                "token": piece,
                "index": index,
                "elapsed_ms": elapsed_ms,
            }, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                stream_callback_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {stream_secret}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_sec, context=_WORKER_CALLBACK_SSL_CONTEXT) as resp:
                resp.read(128)
        except Exception:
            pass

    def _stream_callback_loop() -> None:
        while True:
            try:
                piece, index, elapsed_ms = stream_callback_queue.get(timeout=0.25)
            except Exception:
                if stream_callback_done.is_set():
                    return
                continue
            try:
                if piece is None:
                    return
                _post_stream_token(piece, index, elapsed_ms)
            finally:
                stream_callback_queue.task_done()

    def emit_stream_token(piece: str, index: int, elapsed_ms: int) -> None:
        nonlocal stream_callback_worker
        if not piece or not stream_id or not stream_secret or not stream_callback_url:
            return
        if stream_callback_worker is None:
            stream_callback_worker = threading.Thread(target=_stream_callback_loop, daemon=True)
            stream_callback_worker.start()
        if index == 1:
            _post_stream_token(piece, index, elapsed_ms, timeout_sec=0.8)
            return
        try:
            stream_callback_queue.put_nowait((piece, index, elapsed_ms))
        except queue.Full:
            # Le stream UI ne doit jamais ralentir le décodage Metal.
            pass

    def drain_stream_callbacks(timeout_sec: float = 5.0) -> None:
        if stream_callback_worker is None:
            return
        deadline = time.perf_counter() + timeout_sec
        while time.perf_counter() < deadline:
            if stream_callback_queue.unfinished_tasks == 0:
                break
            time.sleep(0.01)
        stream_callback_done.set()
        try:
            stream_callback_queue.put((None, 0, 0))
        except Exception:
            pass
        try:
            stream_callback_worker.join(timeout=0.3)
        except Exception:
            pass

    try:
        from mlx_lm import load, stream_generate
        from mlx_lm.sample_utils import make_logits_processors, make_sampler
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"mlx_lm_unavailable:{type(exc).__name__}:{exc}"}).encode()

    load_ms = 0
    cache_hit = load_model_id in _mlx_lm_models
    with _mlx_lm_lock:
        cache_hit = load_model_id in _mlx_lm_models
        if not cache_hit:
            t_load = time.perf_counter()
            model, tokenizer = load(load_model_id)
            _mlx_lm_models[load_model_id] = model
            _mlx_lm_tokenizers[load_model_id] = tokenizer
            load_ms = int((time.perf_counter() - t_load) * 1000)
            _mlx_lm_stats[load_model_id] = {
                "loads": int((_mlx_lm_stats.get(load_model_id) or {}).get("loads") or 0) + 1,
                "last_load_ms": load_ms,
                "loaded_at_ms": int(time.time() * 1000),
                "requested_model_id": model_id,
            }
        model = _mlx_lm_models[load_model_id]
        tokenizer = _mlx_lm_tokenizers[load_model_id]
        generation_lock = _mlx_lm_generation_locks.setdefault(load_model_id, threading.Lock())

    def _tokenizer_impl(tok: Any) -> Any:
        return (
            getattr(tok, "tokenizer", None)
            or getattr(tok, "_tokenizer", None)
            or getattr(tok, "_tokenizer_wrapper", None)
            or tok
        )

    def _build_generation_prompt() -> tuple[str, str]:
        if payload.get("formatted_prompt") is True:
            return prompt, "caller_formatted"
        tok = _tokenizer_impl(tokenizer)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        apply_chat_template = getattr(tok, "apply_chat_template", None)
        if callable(apply_chat_template):
            try:
                rendered = apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
                if isinstance(rendered, str) and rendered.strip():
                    return rendered, "chat_template_no_thinking"
            except TypeError:
                try:
                    rendered = apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                except Exception:
                    rendered = None
            except Exception:
                rendered = None
            try:
                if isinstance(rendered, str) and rendered.strip():
                    return rendered, "chat_template"
            except Exception:
                pass
        return f"<|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n", "qwen_fallback_template"

    def _strip_private_reasoning(text: str) -> str:
        cleaned = text or ""
        lower = cleaned.lower()
        if "<think>" in lower and "</think>" in lower:
            end = lower.rfind("</think>")
            cleaned = cleaned[end + len("</think>"):]
        markers = ("thinking process:", "reasoning:", "analyse:", "analysis:")
        lowered = cleaned.lower().lstrip()
        for marker in markers:
            if lowered.startswith(marker):
                # Si le modèle a tout de même commencé par son brouillon, on ne
                # l'expose pas au chat. On renvoie le dernier paragraphe utile.
                parts = [p.strip() for p in cleaned.split("\n\n") if p.strip()]
                if parts:
                    cleaned = parts[-1]
                break
        return cleaned.strip()

    generation_prompt, prompt_format = _build_generation_prompt()
    try:
        temperature = float(payload.get("temperature", SAMPLING_TEMPERATURE))
    except (TypeError, ValueError):
        temperature = SAMPLING_TEMPERATURE
    try:
        top_p = float(payload.get("top_p", SAMPLING_TOP_P))
    except (TypeError, ValueError):
        top_p = SAMPLING_TOP_P
    try:
        top_k = int(payload.get("top_k", SAMPLING_TOP_K))
    except (TypeError, ValueError):
        top_k = SAMPLING_TOP_K
    try:
        repetition_penalty = float(payload.get("repetition_penalty", REPETITION_PENALTY))
    except (TypeError, ValueError):
        repetition_penalty = REPETITION_PENALTY
    temperature = max(0.0, min(2.0, temperature))
    top_p = max(0.0, min(1.0, top_p))
    top_k = max(0, min(200, top_k))
    repetition_penalty = max(1.0, min(2.0, repetition_penalty))
    sampler = make_sampler(temp=temperature, top_p=top_p, top_k=top_k)
    logits_processors = make_logits_processors(
        repetition_penalty=repetition_penalty,
        repetition_context_size=96,
    )

    chunks: list[str] = []
    token_count = 0
    first_token_ms: int | None = None
    t0 = time.perf_counter()
    acquired = generation_lock.acquire(timeout=MLX_LM_BUSY_TIMEOUT_SEC)
    if not acquired:
        return json.dumps({
            "ok": False,
            "error": "mlx_lm_busy: generation deja en cours sur ce worker",
            "runtime_backend": "mlx_lm",
            "model_id": model_id,
            "load_model_id": load_model_id,
            "load_ms": load_ms,
            "cache_hit": cache_hit,
            "cache_status": "hit" if cache_hit else "loaded",
            "retryable": True,
        }, ensure_ascii=False).encode()

    try:
        token_events: list[dict[str, Any]] = []
        stream_buffer: list[str] = []
        stream_emit_index = 0
        last_stream_emit_ms = 0
        stop_reason = "length"
        # mlx-lm/Metal is not reliably re-entrant on one resident model.
        # Reject overlapping retries quickly instead of letting the P2P hop time out.
        prompt_tokens_seen = 0
        peak_memory_gb = None
        for response in stream_generate(
            model,
            tokenizer,
            generation_prompt,
            max_tokens=max_tokens,
            sampler=sampler,
            logits_processors=logits_processors,
            max_kv_size=MLX_LM_MAX_KV_SIZE,
            prefill_step_size=MLX_LM_PREFILL_STEP_SIZE,
        ):
            elapsed = time.perf_counter() - t0
            if elapsed > MLX_LM_MAX_SECONDS:
                stop_reason = "worker_time_budget"
                break
            if first_token_ms is None:
                first_token_ms = int(elapsed * 1000)
            finish_reason = getattr(response, "finish_reason", None)
            if isinstance(finish_reason, str) and finish_reason:
                stop_reason = finish_reason
            prompt_tokens_seen = int(getattr(response, "prompt_tokens", prompt_tokens_seen) or prompt_tokens_seen)
            peak_memory_gb = getattr(response, "peak_memory", peak_memory_gb)
            token_count += 1
            piece = str(getattr(response, "text", "") or "")
            chunks.append(piece)
            stream_buffer.append(piece)
            elapsed_ms = int(elapsed * 1000)
            should_flush_stream = (
                token_count == 1
                or token_count % MLX_LM_STREAM_CHUNK_TOKENS == 0
                or (MLX_LM_STREAM_CHUNK_MS > 0 and elapsed_ms - last_stream_emit_ms >= MLX_LM_STREAM_CHUNK_MS)
            )
            if should_flush_stream:
                stream_piece = "".join(stream_buffer)
                stream_buffer.clear()
                stream_emit_index += 1
                last_stream_emit_ms = elapsed_ms
                emit_stream_token(stream_piece, stream_emit_index, elapsed_ms)
            token_events.append({
                "index": token_count,
                "text": piece,
                "elapsed_ms": int(elapsed * 1000),
            })
        if stream_buffer:
            stream_emit_index += 1
            emit_stream_token("".join(stream_buffer), stream_emit_index, int((time.perf_counter() - t0) * 1000))
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "error": f"mlx_lm_generate_failed:{type(exc).__name__}:{exc}",
            "runtime_backend": "mlx_lm",
            "model_id": model_id,
            "load_model_id": load_model_id,
            "load_ms": load_ms,
            "cache_hit": cache_hit,
            "cache_status": "hit" if cache_hit else "loaded",
        }, ensure_ascii=False).encode()
    finally:
        try:
            import mlx.core as mx
            mx.synchronize()
            if os.environ.get("VRYX_MLX_CLEAR_CACHE_AFTER_GENERATION", "0").lower() in ("1", "true", "yes"):
                mx.clear_cache()
        except Exception:
            pass
        generation_lock.release()

    generation_ms = max(1, int((time.perf_counter() - t0) * 1000))
    drain_stream_callbacks()
    return json.dumps({
        "ok": True,
        "runtime_backend": "mlx_lm",
        "model_id": model_id,
        "load_model_id": load_model_id,
        "text": _strip_private_reasoning("".join(chunks)),
        "completion_tokens": token_count,
        "prompt_tokens": prompt_tokens_seen,
        "total_tokens": prompt_tokens_seen + token_count,
        "load_ms": load_ms,
        "mlx_lm_load_ms": load_ms,
        "cache_hit": cache_hit,
        "cache_status": "hit" if cache_hit else "loaded",
        "resident_model": True,
        "model_cache_size": len(_mlx_lm_models),
        "generation_ms": generation_ms,
        "ttft_ms": first_token_ms,
        "token_events": token_events,
        "requested_max_tokens": requested_max_tokens,
        "effective_max_tokens": max_tokens,
        "stop_reason": stop_reason,
        "actual_tps": round(token_count * 1000.0 / generation_ms, 3) if generation_ms > 0 else 0,
        "decode_mode": "mlx_lm_direct_stream_generate",
        "prompt_format": prompt_format,
        "sampling": {
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "repetition_penalty": repetition_penalty,
        },
        "max_kv_size": MLX_LM_MAX_KV_SIZE,
        "prefill_step_size": MLX_LM_PREFILL_STEP_SIZE,
        "peak_memory_gb": peak_memory_gb,
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


class _Qwen3_5MoeWorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.config = config
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.embed_tokens = torch.nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = torch.nn.ModuleList([
            Qwen3_5MoeDecoderLayer(config, layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.norm = Qwen3_5MoeRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
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


class _LlamaWorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.config = config
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.embed_tokens = torch.nn.Embedding(config.vocab_size, config.hidden_size)
        layers = []
        for i in range(layer_end - layer_start + 1):
            layer_idx = layer_start + i
            try:
                layers.append(LlamaDecoderLayer(config, layer_idx))
            except TypeError:
                layers.append(LlamaDecoderLayer(config))
        self.layers = torch.nn.ModuleList(layers)
        if has_lm_head:
            self.norm = LlamaRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        if LlamaRotaryEmbedding is not None:
            try:
                self.rotary_emb = LlamaRotaryEmbedding(config=config)
            except TypeError:
                try:
                    self.rotary_emb = LlamaRotaryEmbedding(
                        config.hidden_size // config.num_attention_heads,
                        max_position_embeddings=config.max_position_embeddings,
                        base=config.rope_theta,
                    )
                except Exception:
                    self.rotary_emb = None
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
    elif model_type in ("qwen3_5_moe", "qwen3_5_moe_text") and HAS_QWEN3_5_MOE:
        config = Qwen3_5MoeTextConfig(
            hidden_size=cfg_d.get("hidden_size", 2048),
            num_hidden_layers=cfg_d.get("num_hidden_layers_total", 40),
            num_attention_heads=cfg_d.get("num_attention_heads", 16),
            num_key_value_heads=cfg_d.get("num_key_value_heads", 2),
            head_dim=cfg_d.get("head_dim") or 256,
            vocab_size=cfg_d.get("vocab_size", 248320),
            rms_norm_eps=float(cfg_d.get("rms_norm_eps", 1e-6)),
            rope_parameters=cfg_d.get("rope_parameters"),
            max_position_embeddings=int(cfg_d.get("max_position_embeddings", 262144)),
            attention_bias=bool(cfg_d.get("attention_bias", False)),
            hidden_act=cfg_d.get("hidden_act", "silu"),
            layer_types=cfg_d.get("layer_types"),
            linear_conv_kernel_dim=cfg_d.get("linear_conv_kernel_dim") or 4,
            linear_key_head_dim=cfg_d.get("linear_key_head_dim") or 128,
            linear_value_head_dim=cfg_d.get("linear_value_head_dim") or 128,
            linear_num_key_heads=cfg_d.get("linear_num_key_heads") or 16,
            linear_num_value_heads=cfg_d.get("linear_num_value_heads") or 32,
            moe_intermediate_size=cfg_d.get("moe_intermediate_size") or 512,
            shared_expert_intermediate_size=cfg_d.get("shared_expert_intermediate_size") or 512,
            num_experts_per_tok=cfg_d.get("num_experts_per_tok") or 8,
            num_experts=cfg_d.get("num_experts") or 256,
            output_router_logits=bool(cfg_d.get("output_router_logits", False)),
            router_aux_loss_coef=float(cfg_d.get("router_aux_loss_coef", 0.001)),
        )
        model = _Qwen3_5MoeWorkerSlice(
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
    elif model_type == "llama" and HAS_LLAMA:
        config = LlamaConfig(
            hidden_size=cfg_d.get("hidden_size", 8192),
            intermediate_size=cfg_d.get("intermediate_size", 28672),
            num_hidden_layers=cfg_d.get("num_hidden_layers_total", 80),
            num_attention_heads=cfg_d.get("num_attention_heads", 64),
            num_key_value_heads=cfg_d.get("num_key_value_heads", cfg_d.get("num_attention_heads", 64)),
            vocab_size=cfg_d.get("vocab_size", 32000),
            rms_norm_eps=float(cfg_d.get("rms_norm_eps", 1e-5)),
            rope_theta=float(cfg_d.get("rope_theta", 10000.0)),
            max_position_embeddings=int(cfg_d.get("max_position_embeddings", 4096)),
            hidden_act=str(cfg_d.get("hidden_act") or "silu"),
            attention_bias=bool(cfg_d.get("attention_bias", False)),
            mlp_bias=bool(cfg_d.get("mlp_bias", False)),
            tie_word_embeddings=bool(cfg_d.get("tie_word_embeddings", False)),
        )
        model = _LlamaWorkerSlice(
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


def _copy_http_range_to_file(url: str, start: int, nbytes: int, out_file: Any, ssl_context: Any) -> None:
    """Copie exactement une plage HTTP dans `out_file` sans charger le tenseur en RAM."""
    if nbytes <= 0:
        return
    req = urllib.request.Request(url, method="GET")
    req.add_header("Range", f"bytes={start}-{start + nbytes - 1}")
    with urllib.request.urlopen(req, timeout=SHARD_BINARY_FETCH_TIMEOUT_SEC, context=ssl_context) as resp:
        status = int(getattr(resp, "status", 0) or resp.getcode() or 0)
        if status != 206:
            raise RuntimeError(f"range_non_supporte:{status}:{url}")
        remaining = nbytes
        while remaining > 0:
            chunk = resp.read(min(8 * 1024 * 1024, remaining))
            if not chunk:
                break
            out_file.write(chunk)
            remaining -= len(chunk)
        if remaining != 0:
            raise RuntimeError(f"range_incomplet:{nbytes - remaining}/{nbytes}:{url}")


def _copy_http_range_to_path_at(url: str, source_start: int, nbytes: int, path: str, dest_offset: int, ssl_context: Any) -> None:
    """Copie une plage HTTP à un offset précis du cache local, sans sérialiser tous les tenseurs."""
    if nbytes <= 0:
        return
    req = urllib.request.Request(url, method="GET")
    req.add_header("Range", f"bytes={source_start}-{source_start + nbytes - 1}")
    with urllib.request.urlopen(req, timeout=SHARD_BINARY_FETCH_TIMEOUT_SEC, context=ssl_context) as resp:
        status = int(getattr(resp, "status", 0) or resp.getcode() or 0)
        if status != 206:
            raise RuntimeError(f"range_non_supporte:{status}:{url}")
        fd = os.open(path, os.O_WRONLY)
        try:
            remaining = nbytes
            write_at = dest_offset
            while remaining > 0:
                chunk = resp.read(min(8 * 1024 * 1024, remaining))
                if not chunk:
                    break
                os.pwrite(fd, chunk, write_at)
                write_at += len(chunk)
                remaining -= len(chunk)
            if remaining != 0:
                raise RuntimeError(f"range_incomplet:{nbytes - remaining}/{nbytes}:{url}")
        finally:
            os.close(fd)


def _array_from_raw_file(path: str, dtype_name: str, offset: int, shape: tuple[int, ...]) -> np.ndarray:
    """Retourne un ndarray/memmap pour un tenseur shardé.

    NumPy standard ne comprend pas le bfloat16 brut des safetensors. Les tenseurs
    BF16 restants dans les shards MLX quantifiés sont petits (normes, biais, conv),
    donc on les convertit en fp16 au chargement worker.
    """
    dtype_norm = str(dtype_name or "float16").lower()
    if dtype_norm in ("bfloat16", "bf16"):
        raw = np.memmap(path, dtype=np.uint16, mode="r", offset=offset, shape=shape)
        fp32 = (np.asarray(raw, dtype=np.uint32) << np.uint32(16)).view(np.float32)
        return fp32.astype(np.float16, copy=False)
    mm = np.memmap(path, dtype=np.dtype(dtype_norm), mode="r", offset=offset, shape=shape)
    return np.array(mm, copy=True)


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
    setattr(_shards[sid], "load_error", "")
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
            tensor_sources = shard_data.get("tensor_sources") or []
            if tensor_sources:
                expected = int(shard_data.get("binary_total_bytes") or sum(int(e.get("nbytes") or 0) for e in tensor_sources))
                manifest_format = str(shard_data.get("format") or "").lower()
                is_gguf_ranges = manifest_format == "gguf-ranges-v1" or any("ggml_type" in e for e in tensor_sources)
                shard.weight_bytes = expected
                print(
                    f"[shard] Téléchargement ranges {'GGUF' if is_gguf_ranges else 'safetensors'} : "
                    f"{len(tensor_sources)} tenseurs ({expected / 1e6:.1f} MB)"
                )

                cache_dir = os.environ.get("VRYX_WORKER_SHARD_CACHE_DIR", "/tmp/vryx-worker-shards")
                os.makedirs(cache_dir, exist_ok=True)
                model_cache_key = "".join(
                    ch if ch.isalnum() or ch in ("-", "_") else "_"
                    for ch in f"{shard.model_id or shard.model_config.get('model_type', 'model')}-"
                              f"{shard.layer_start}-{shard.layer_end}-"
                              f"emb{int(shard.has_embedding)}-head{int(shard.has_lm_head)}-"
                              f"ranges-{len(tensor_sources)}-{expected}"
                )
                bin_local_path = os.path.join(cache_dir, f"{model_cache_key}.bin")
                if os.path.exists(bin_local_path) and expected and os.path.getsize(bin_local_path) != expected:
                    os.remove(bin_local_path)

                local_index: list[dict[str, Any]] = []
                offset = 0
                for entry in tensor_sources:
                    nbytes = int(entry.get("nbytes") or 0)
                    local_index.append({
                        "name": str(entry.get("name") or ""),
                        "shape": entry.get("shape") or [],
                        "dtype": str(entry.get("dtype") or "float16"),
                        "ggml_type": entry.get("ggml_type"),
                        "offset": offset,
                        "source_url": str(entry.get("source_url") or ""),
                        "source_offset": int(entry.get("source_offset") or 0),
                        "nbytes": nbytes,
                    })
                    offset += nbytes

                if is_gguf_ranges:
                    print("[shard] GGUF lazy actif : aucun téléchargement compact initial, lecture range à la demande")
                elif not (expected and os.path.exists(bin_local_path) and os.path.getsize(bin_local_path) >= expected):
                    print(f"[shard] Cache MISS ranges -> téléchargement vers {bin_local_path}")
                    part_path = f"{bin_local_path}.part"
                    if os.path.exists(part_path):
                        os.remove(part_path)
                    parallel_ranges = max(1, int(os.environ.get("VRYX_RANGE_DOWNLOAD_PARALLELISM", "8") or "8"))
                    if parallel_ranges > 1 and len(tensor_sources) > 1:
                        with open(part_path, "wb") as out_bin:
                            out_bin.truncate(expected)

                        def _download_one_range(idx_entry: tuple[int, dict[str, Any]]) -> int:
                            idx, entry = idx_entry
                            source_url = str(entry.get("source_url") or "")
                            source_offset = int(entry.get("source_offset") or 0)
                            nbytes = int(entry.get("nbytes") or 0)
                            if not source_url or nbytes <= 0:
                                raise RuntimeError(f"tensor_source invalide: {entry}")
                            dest_offset = int(local_index[idx - 1]["offset"])
                            for attempt in range(5):
                                try:
                                    _copy_http_range_to_path_at(source_url, source_offset, nbytes, part_path, dest_offset, _ctx)
                                    return idx
                                except Exception as ex:
                                    if attempt == 4:
                                        raise
                                    print(
                                        f"[shard] Range retry {idx}/{len(tensor_sources)} "
                                        f"tentative {attempt + 1}: {ex}"
                                    )
                                    time.sleep(2.0)
                            return idx

                        done_ranges = 0
                        with concurrent.futures.ThreadPoolExecutor(max_workers=parallel_ranges) as executor:
                            futures = [
                                executor.submit(_download_one_range, (idx, entry))
                                for idx, entry in enumerate(tensor_sources, start=1)
                            ]
                            for future in concurrent.futures.as_completed(futures):
                                idx = future.result()
                                done_ranges += 1
                                if done_ranges == 1 or done_ranges == len(tensor_sources) or done_ranges % 32 == 0:
                                    print(
                                        f"[shard] Range {done_ranges}/{len(tensor_sources)} OK "
                                        f"(dernier={idx}, parallel={parallel_ranges})"
                                    )
                    else:
                        with open(part_path, "wb") as out_bin:
                            for idx, entry in enumerate(tensor_sources, start=1):
                                source_url = str(entry.get("source_url") or "")
                                source_offset = int(entry.get("source_offset") or 0)
                                nbytes = int(entry.get("nbytes") or 0)
                                if not source_url or nbytes <= 0:
                                    raise RuntimeError(f"tensor_source invalide: {entry}")
                                for attempt in range(5):
                                    try:
                                        _copy_http_range_to_file(source_url, source_offset, nbytes, out_bin, _ctx)
                                        if idx == 1 or idx == len(tensor_sources) or idx % 32 == 0:
                                            print(f"[shard] Range {idx}/{len(tensor_sources)} OK")
                                        break
                                    except Exception as ex:
                                        if attempt == 4:
                                            raise
                                        print(
                                            f"[shard] Range retry {idx}/{len(tensor_sources)} "
                                            f"tentative {attempt + 1}: {ex}"
                                        )
                                        time.sleep(2.0)
                    os.replace(part_path, bin_local_path)
                elif not is_gguf_ranges:
                    print(f"[shard] Cache HIT ranges : {bin_local_path}")

                if not is_gguf_ranges and expected and os.path.getsize(bin_local_path) < expected:
                    raise RuntimeError(f"Download ranges incomplet : {os.path.getsize(bin_local_path)}/{expected}")

                if is_gguf_ranges:
                    setattr(shard, "gguf_tensor_index", local_index)
                    setattr(shard, "gguf_backend_ready", False)
                    n_weights = len(local_index)
                    setattr(shard, "weight_file_path", "")
                else:
                    for entry in local_index:
                        name = entry["name"]
                        shape = tuple(int(x) for x in entry["shape"])
                        off = int(entry["offset"])
                        arr = _array_from_raw_file(bin_local_path, str(entry["dtype"]), off, shape)
                        shard.weight_arrays[name] = arr
                        n_weights += 1
                    setattr(shard, "weight_file_path", bin_local_path)
                setattr(shard, "weight_load_mode", "gguf_ranges" if is_gguf_ranges else "safetensors_ranges")
            elif bin_url and weights_index:
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
                    off = int(entry["offset"])
                    nbytes = int(entry["nbytes"])
                    arr = _array_from_raw_file(bin_local_path, str(entry["dtype"]), off, shape)
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
            if getattr(shard, "weight_load_mode", "") == "gguf_ranges":
                shard.backend = _select_backend(shard, {"runtime_backend": getattr(shard, "runtime_backend", "mlx")})
                build_res = json.loads(pipeline_shard_build(sid))
                setattr(shard, "loading", False)
                if build_res.get("ok"):
                    setattr(shard, "build_ready", True)
                    return json.dumps({
                        "ok": True,
                        "session_id": sid,
                        "num_layers": n_layers,
                        "weights_loaded": n_weights,
                        "download_ms": elapsed,
                        "weight_load_mode": "gguf_ranges",
                        "runtime_ready": True,
                        "runtime_backend": build_res.get("runtime_backend"),
                        "build_ms": build_res.get("build_ms"),
                    })
                return json.dumps({
                    "ok": False,
                    "session_id": sid,
                    "weights_loaded": n_weights,
                    "download_ms": elapsed,
                    "weight_load_mode": "gguf_ranges",
                    "runtime_ready": False,
                    "error": f"Build GGUF échoué : {build_res.get('error')}",
                    "runtime_backend": build_res.get("runtime_backend"),
                    "runtime_fallback_reason": build_res.get("runtime_fallback_reason"),
                })

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
                shard_ref = _shards.get(sid)
                setattr(shard_ref, "loading", False)
                setattr(shard_ref, "load_error", str(e)[:500])
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
            if (
                getattr(shard, "weight_load_mode", "") == "gguf_ranges"
                or os.environ.get("VRYX_DISABLE_PYTORCH_FALLBACK", "0").lower() in ("1", "true", "yes")
            ):
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
                except TypeError as type_error:
                    if "position_embeddings" in kwargs and "position_embeddings" in str(type_error):
                        kwargs.pop("position_embeddings", None)
                        layer_out = layer(hidden_states, **kwargs)
                    else:
                        raise
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
            response = {
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
            }
            debug_top_logits = _debug_top_logits_torch(logits)
            if debug_top_logits:
                response["debug_top_logits"] = debug_top_logits
            return json.dumps(response).encode()
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
    full_model_gb = 0.0
    try:
        full_model_gb = float(os.environ.get("VRYX_WORKER_MODEL_EFFECTIVE_GB") or os.environ.get("VRYX_WORKER_MODEL_TOTAL_GB") or "0")
    except (TypeError, ValueError):
        full_model_gb = 0.0
    full_model_bytes = int(max(0.0, full_model_gb) * 1024 ** 3)
    try:
        full_model_layers = int(os.environ.get("VRYX_WORKER_MODEL_TOTAL_LAYERS") or "0")
    except (TypeError, ValueError):
        full_model_layers = 0
    for load_model_id, model in list(_mlx_lm_models.items()):
        stats = _mlx_lm_stats.get(load_model_id) or {}
        requested_model_id = str(stats.get("requested_model_id") or os.environ.get("VRYX_WORKER_MODEL") or load_model_id)
        sid = f"mlx-full:{load_model_id}"
        if only_session and sid != only_session:
            continue
        layers = max(1, full_model_layers)
        shards.append({
            "session_id": sid,
            "model_id": requested_model_id,
            "load_model_id": load_model_id,
            "pool_id": "local-full",
            "layer_start": 0,
            "layer_end": layers - 1,
            "num_layers": layers,
            "has_embedding": True,
            "has_lm_head": True,
            "weights_loaded": 1,
            "weight_bytes": full_model_bytes,
            "resident_weight_bytes": full_model_bytes,
            "memory_mode": "mlx_lm_full",
            "mlx_strict": False,
            "fallback_disabled": False,
            "built": True,
            "ready": True,
            "resident_vram": True,
            "weight_load_mode": "mlx_lm_full",
            "download_ms": int(stats.get("last_load_ms") or 0),
            "build_ms": int(stats.get("last_load_ms") or 0),
            "last_forward_ms": 0,
            "hidden_transport": "mlx_lm_native",
            "q4_supported": True,
            "int8_supported": True,
            "weight_quantization": "mlx_lm_native",
            "runtime_backend": "mlx_lm",
            "requested_runtime_backend": "mlx_lm",
            "runtime_fallback_reason": None,
            "supports_q4_weights": True,
            "supports_mlx": True,
            "supports_vllm": False,
            "kv_cache_ready": True,
            "worker_kv_cache": True,
            "last_decode_mode": "mlx_lm_direct_stream_generate",
            "attention_backend": "mlx_lm",
            "flash_attention": False,
            "linear_attn_ready": False,
            "state_bytes": 0,
            "state_pages": None,
            "paged_kv_cache": False,
            "hidden_quic": False,
            "quic_available": False,
            "prefix_cache": False,
            "speculative_heads": 0,
            "speculative_available": False,
            "continuous_batching": False,
            "batch_forward": False,
            "chunked_prefill": False,
            "ring_attention": False,
            "age_sec": max(0, int((int(time.time() * 1000) - int(stats.get("loaded_at_ms") or 0)) / 1000)) if stats.get("loaded_at_ms") else 0,
            "idle_sec": 0,
            "ttl_sec": 0,
        })
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
            "loading": bool(getattr(shard, "loading", False)),
            "load_error": str(getattr(shard, "load_error", "") or ""),
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


if os.environ.get("VRYX_RUNTIME_BACKEND", "").strip().lower().startswith("llama") or os.environ.get(
    "VRYX_LLAMA_CPP_DIRECT",
    "0",
).strip().lower() in ("1", "true", "yes", "on"):
    start_llama_cpp_warmup_once()
