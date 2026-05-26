"""Lazy GGUF/Q4 MLX backend for Llama pipeline shards.

This backend is intentionally worker-side: the VPS only exposes GGUF byte
ranges, while each worker downloads its assigned tensors and executes its slice.
Weights are dequantized lazily from the local range cache, then kept in a bounded
LRU cache so a worker never has to materialize the full 70B model.
"""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.request
from collections import OrderedDict
from typing import Any, Iterator

import numpy as np

from mlx_backend import (
    MLXBackend,
    _SCAN_BACKEND_ENV,
    _STATE_ALLOCATOR,
    _mlx_clear_cache,
    _mx_rope_freqs,
    _normalize_scan_backend,
    _rss_mb,
)

try:
    import gguf.quants as gguf_quants  # type: ignore
except Exception:  # pragma: no cover - optional dependency handled at runtime.
    gguf_quants = None  # type: ignore


def _truthy_env(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _range_ssl_context(source_url: str) -> ssl.SSLContext | None:
    if not source_url.startswith("https://"):
        return None
    internal_hosts = tuple(
        item.strip().lower()
        for item in os.environ.get("VRYX_INTERNAL_SHARD_TLS_SKIP_VERIFY_HOSTS", "vryx.eu").split(",")
        if item.strip()
    )
    if internal_hosts and not any(host in source_url.lower() for host in internal_hosts):
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _qtype(value: Any) -> Any:
    if gguf_quants is None:
        raise RuntimeError("gguf_package_missing")
    try:
        return gguf_quants.GGMLQuantizationType(int(value))
    except Exception:
        return int(value)


def _dequantize(raw: np.ndarray, ggml_type: Any, shape: tuple[int, ...]) -> np.ndarray:
    if gguf_quants is None:
        raise RuntimeError("gguf_package_missing")
    out = gguf_quants.dequantize(raw, _qtype(ggml_type))
    arr = np.asarray(out)
    if shape:
        try:
            arr = arr.reshape(shape)
        except ValueError:
            # Some gguf-py releases expose tensor.shape in storage order. The
            # transpose path is still deterministic and makes startup failures
            # explicit if neither shape matches later.
            arr = arr.reshape(tuple(reversed(shape))).T
    # GGUF stores dense matrices in llama.cpp orientation ([in, out]) while the
    # MLX transformer path below mirrors Hugging Face weights ([out, in]).
    # Scalars/vectors keep their native shape; every 2D tensor is transposed once
    # so embedding lookup, projections and lm_head all agree on hidden_size.
    if arr.ndim == 2:
        arr = arr.T
    elif arr.ndim == 3:
        arr = np.transpose(arr, (2, 1, 0))
    elif arr.ndim > 3:
        arr = np.swapaxes(arr, -1, -2)
    return np.ascontiguousarray(arr, dtype=np.float16)


def _map_gguf_name(name: str, layer_start: int) -> str | None:
    if name == "token_embd.weight":
        return "embed_tokens.weight"
    if name == "output_norm.weight":
        return "norm.weight"
    if name == "output.weight":
        return "lm_head.weight"
    if not name.startswith("blk."):
        return None
    parts = name.split(".")
    if len(parts) < 3:
        return None
    try:
        global_layer = int(parts[1])
    except ValueError:
        return None
    local = global_layer - layer_start
    tail = ".".join(parts[2:])
    mapping = {
        "attn_norm.weight": f"layers.{local}.input_layernorm.weight",
        "ffn_norm.weight": f"layers.{local}.post_attention_layernorm.weight",
        "post_attention_norm.weight": f"layers.{local}.post_attention_layernorm.weight",
        "attn_q.weight": f"layers.{local}.self_attn.q_proj.weight",
        "attn_k.weight": f"layers.{local}.self_attn.k_proj.weight",
        "attn_v.weight": f"layers.{local}.self_attn.v_proj.weight",
        "attn_output.weight": f"layers.{local}.self_attn.o_proj.weight",
        "attn_qkv.weight": f"layers.{local}.linear_attn.in_proj_qkv.weight",
        "attn_gate.weight": f"layers.{local}.linear_attn.in_proj_z.weight",
        "ssm_alpha.weight": f"layers.{local}.linear_attn.in_proj_a.weight",
        "ssm_beta.weight": f"layers.{local}.linear_attn.in_proj_b.weight",
        "ssm_conv1d.weight": f"layers.{local}.linear_attn.conv1d.weight",
        "ssm_dt.bias": f"layers.{local}.linear_attn.dt_bias",
        "ssm_a": f"layers.{local}.linear_attn.A_log",
        "ssm_norm.weight": f"layers.{local}.linear_attn.norm.weight",
        "ssm_out.weight": f"layers.{local}.linear_attn.out_proj.weight",
        "ffn_gate.weight": f"layers.{local}.mlp.gate_proj.weight",
        "ffn_up.weight": f"layers.{local}.mlp.up_proj.weight",
        "ffn_down.weight": f"layers.{local}.mlp.down_proj.weight",
        "ffn_gate_inp.weight": f"layers.{local}.mlp.gate.weight",
        "ffn_gate_exps.weight": f"layers.{local}.mlp.switch_mlp.gate_proj.weight",
        "ffn_up_exps.weight": f"layers.{local}.mlp.switch_mlp.up_proj.weight",
        "ffn_down_exps.weight": f"layers.{local}.mlp.switch_mlp.down_proj.weight",
        "ffn_gate_shexp.weight": f"layers.{local}.mlp.shared_expert.gate_proj.weight",
        "ffn_up_shexp.weight": f"layers.{local}.mlp.shared_expert.up_proj.weight",
        "ffn_down_shexp.weight": f"layers.{local}.mlp.shared_expert.down_proj.weight",
        "ffn_gate_inp_shexp.weight": f"layers.{local}.mlp.shared_expert_gate.weight",
    }
    return mapping.get(tail)


class LazyGgufWeights:
    def __init__(self, shard: Any, mx: Any, *, max_cache_bytes: int) -> None:
        self.shard = shard
        self.mx = mx
        self.path = str(getattr(shard, "weight_file_path", "") or "")
        self.max_cache_bytes = max(256 * 1024 * 1024, int(max_cache_bytes))
        self.entries: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, str] = {}
        self.cache: OrderedDict[str, tuple[Any, int]] = OrderedDict()
        self.cache_bytes = 0
        self.estimated_dense_bytes = 0
        self.raw_mapped_samples: list[dict[str, str]] = []
        self.raw_unmapped_samples: list[str] = []
        for raw_entry in list(getattr(shard, "gguf_tensor_index", []) or []):
            if not isinstance(raw_entry, dict):
                continue
            raw_name = str(raw_entry.get("name") or "")
            mapped = _map_gguf_name(raw_name, int(getattr(shard, "layer_start", 0)))
            if not mapped:
                if len(self.raw_unmapped_samples) < 40:
                    self.raw_unmapped_samples.append(raw_name)
                continue
            entry = dict(raw_entry)
            entry["mapped_name"] = mapped
            if len(self.raw_mapped_samples) < 80:
                self.raw_mapped_samples.append({
                    "raw": raw_name,
                    "mapped": mapped,
                    "shape": list(entry.get("shape") or []),
                    "nbytes": int(entry.get("nbytes") or 0),
                    "ggml_type": entry.get("ggml_type"),
                })
            self.entries[mapped] = entry
            self.aliases[raw_name] = mapped
            shape = tuple(int(x) for x in (entry.get("shape") or []))
            if shape:
                elems = 1
                for dim in shape:
                    elems *= max(0, int(dim))
                self.estimated_dense_bytes += elems * 2
        if "lm_head.weight" not in self.entries and "embed_tokens.weight" in self.entries:
            # Llama GGUF may tie output to token embeddings.
            self.entries["lm_head.weight"] = self.entries["embed_tokens.weight"]

    def __len__(self) -> int:
        return len(self.entries)

    def __bool__(self) -> bool:
        return bool(self.entries)

    def __contains__(self, key: str) -> bool:
        return key in self.entries

    def __iter__(self) -> Iterator[str]:
        return iter(self.entries)

    def keys(self) -> Any:
        return self.entries.keys()

    def items(self) -> Any:
        return ((key, self[key]) for key in self.entries.keys())

    def __getitem__(self, key: str) -> Any:
        value = self.get(key)
        if value is None:
            raise KeyError(key)
        return value

    def __setitem__(self, key: str, value: Any) -> None:
        try:
            nbytes = int(getattr(value, "nbytes", 0) or 0)
        except Exception:
            nbytes = 0
        self.entries[key] = {"mapped_name": key, "shape": list(getattr(value, "shape", []) or [])}
        old = self.cache.pop(key, None)
        if old is not None:
            self.cache_bytes -= int(old[1] or 0)
        self.cache[key] = (value, nbytes)
        self.cache_bytes += nbytes
        self._evict_if_needed(protect=key)

    def pop(self, key: str, default: Any = None) -> Any:
        mapped = self.aliases.get(key, key)
        cached = self.cache.pop(mapped, None)
        self.entries.pop(mapped, None)
        if cached is None:
            return default
        self.cache_bytes -= int(cached[1] or 0)
        return cached[0]

    def clear(self) -> None:
        self.cache.clear()
        self.cache_bytes = 0

    def get(self, key: str, default: Any = None) -> Any:
        mapped = self.aliases.get(key, key)
        if mapped in self.cache:
            value, nbytes = self.cache.pop(mapped)
            self.cache[mapped] = (value, nbytes)
            return value
        entry = self.entries.get(mapped)
        if not entry:
            return default
        value, nbytes = self._load_entry(entry)
        self.cache[mapped] = (value, nbytes)
        self.cache_bytes += nbytes
        self._evict_if_needed(protect=mapped)
        return value

    def _load_entry(self, entry: dict[str, Any]) -> tuple[Any, int]:
        nbytes = int(entry.get("nbytes") or 0)
        shape = tuple(int(x) for x in (entry.get("shape") or []))
        ggml_type = entry.get("ggml_type")
        if self.path and os.path.isfile(self.path):
            offset = int(entry.get("offset") or 0)
            raw = np.memmap(self.path, dtype=np.uint8, mode="r", offset=offset, shape=(nbytes,))
        else:
            source_url = str(entry.get("source_url") or "")
            source_offset = int(entry.get("source_offset") or 0)
            if not source_url or nbytes <= 0:
                raise RuntimeError("gguf_range_source_missing")
            req = urllib.request.Request(source_url, method="GET")
            req.add_header("Range", f"bytes={source_offset}-{source_offset + nbytes - 1}")
            with urllib.request.urlopen(
                req,
                timeout=float(os.environ.get("VRYX_GGUF_RANGE_FETCH_TIMEOUT_SEC", "180")),
                context=_range_ssl_context(source_url),
            ) as resp:
                status = int(getattr(resp, "status", 0) or resp.getcode() or 0)
                if status != 206:
                    raise RuntimeError(f"gguf_range_non_supporte:{status}")
                data = resp.read(nbytes)
            if len(data) != nbytes:
                raise RuntimeError(f"gguf_range_incomplet:{len(data)}/{nbytes}")
            raw = np.frombuffer(data, dtype=np.uint8)
        dense = _dequantize(raw, ggml_type, shape)
        value = self.mx.array(dense, dtype=self.mx.float16)
        self.mx.eval(value)
        return value, int(dense.nbytes)

    def _evict_if_needed(self, *, protect: str) -> None:
        while self.cache_bytes > self.max_cache_bytes and len(self.cache) > 1:
            key, (_value, nbytes) = next(iter(self.cache.items()))
            if key == protect:
                self.cache.move_to_end(key)
                continue
            self.cache.pop(key, None)
            self.cache_bytes -= nbytes
        if self.cache_bytes > self.max_cache_bytes * 1.10:
            _mlx_clear_cache(self.mx)


class GGUFLazyMLXBackend(MLXBackend):
    name = "mlx_gguf_lazy"

    def __init__(self, shard: Any):
        self.shard = shard
        self.weights: Any = {}
        self.kv_cache: Any = None
        self.linear_states: Any = None
        self.state_page: Any = None
        self._cos: Any = None
        self._sin: Any = None
        self.mx: Any = None
        self.unavailable_reason: str | None = None
        self.scan_backend_requested = _normalize_scan_backend(os.environ.get(_SCAN_BACKEND_ENV))
        self.scan_backend_effective = self.scan_backend_requested
        if not _truthy_env("VRYX_ENABLE_MLX_RUNTIME"):
            self.unavailable_reason = "mlx_runtime_flag_disabled"
            return
        runtime_requested = str(os.environ.get("VRYX_RUNTIME_BACKEND") or "").strip().lower() == "mlx"
        if not (
            runtime_requested
            or _truthy_env("VRYX_ENABLE_GGUF_MLX_SHARD")
            or _truthy_env("VRYX_ENABLE_LLAMA_MLX_SHARD")
        ):
            self.unavailable_reason = "gguf_mlx_shard_flag_disabled"
            return
        if gguf_quants is None:
            self.unavailable_reason = "gguf_package_missing"
            return
        try:
            import mlx.core as mx
            self.mx = mx
        except Exception as exc:
            self.unavailable_reason = f"mlx_unavailable:{exc}"

    @property
    def available(self) -> bool:
        return self.mx is not None and self.unavailable_reason is None

    def build(self) -> dict[str, Any]:
        if not self.available:
            return {"ok": False, "runtime_backend": self.name, "error": self.unavailable_reason or "mlx_unavailable"}
        if str(getattr(self.shard, "weight_load_mode", "")) != "gguf_ranges":
            return {"ok": False, "runtime_backend": self.name, "error": "gguf_ranges_required"}
        t0 = time.perf_counter()
        cache_gb = float(os.environ.get("VRYX_GGUF_MLX_CACHE_GB", "4"))
        self.weights = LazyGgufWeights(self.shard, self.mx, max_cache_bytes=int(cache_gb * 1024**3))
        dense_gb = float(getattr(self.weights, "estimated_dense_bytes", 0) or 0) / 1024**3
        default_budget_gb = max(
            1.0,
            cache_gb * 0.95,
            float(getattr(self.shard, "allocated_vram_mb", 0) or 0) / 1024 * 0.92,
            float(os.environ.get("VRYX_WORKER_MEMORY_LIMIT_GB", "0") or 0) * 0.92,
        )
        max_dense_gb = float(os.environ.get("VRYX_GGUF_DENSE_DEQUANT_MAX_GB", str(default_budget_gb)))
        enforce_dense_budget = _truthy_env("VRYX_GGUF_ENFORCE_DENSE_BUDGET")
        if dense_gb > max_dense_gb and enforce_dense_budget and not _truthy_env("VRYX_ALLOW_UNSAFE_GGUF_DENSE_DEQUANT"):
            return {
                "ok": False,
                "runtime_backend": self.name,
                "error": (
                    "llama70b_q4_kernel_required:"
                    f"dense_fp16_estimate={dense_gb:.1f}GB>"
                    f"budget={max_dense_gb:.1f}GB"
                ),
                "weight_load_mode": "gguf_ranges",
                "weight_quantization": "q4",
                "requires": "native_q4_matmul_or_llama_cpp_shard_forward",
            }
        required = ["embed_tokens.weight"] if self.shard.has_embedding else []
        required += [f"layers.0.input_layernorm.weight"] if self.shard.layer_end >= self.shard.layer_start else []
        required += ["norm.weight", "lm_head.weight"] if self.shard.has_lm_head else []
        missing = [name for name in required if name not in self.weights]
        if missing:
            return {"ok": False, "runtime_backend": self.name, "error": f"gguf_missing_required:{missing[:6]}"}
        cfg = self.shard.model_config
        head_dim = cfg.get("head_dim") or (int(cfg.get("hidden_size", 4096)) // int(cfg.get("num_attention_heads", 32)))
        theta = float(cfg.get("rope_theta", 10_000.0))
        max_len = int(cfg.get("max_position_embeddings", 4096))
        self._cos, self._sin = _mx_rope_freqs(self.mx, int(head_dim), max_len, theta)
        self.mx.eval(self._cos, self._sin)
        self.linear_states = [{} for _ in range(max(0, self.shard.layer_end - self.shard.layer_start + 1))]
        if _STATE_ALLOCATOR is not None:
            self.state_page = _STATE_ALLOCATOR.acquire(self.shard.session_id)
        self.shard.build_ms = int((time.perf_counter() - t0) * 1000)
        setattr(self.shard, "gguf_backend_ready", True)
        setattr(self.shard, "build_ready", True)
        return {
            "ok": True,
            "runtime_backend": "mlx",
            "runtime_backend_detail": self.name,
            "params": len(self.weights),
            "build_ms": self.shard.build_ms,
            "attention_backend": "mlx_metal",
            "kernel_status": "active",
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "linear_attn_backend": self.scan_backend_effective,
            "scan_backend": self.scan_backend_effective,
            "linear_attn_ready": True,
            "weight_load_mode": "gguf_ranges",
            "weight_quantization": "q4",
            "lazy_cache_gb": cache_gb,
            "dense_fp16_estimate_gb": round(dense_gb, 2),
            "compute_dtype": os.environ.get("VRYX_MLX_COMPUTE_DTYPE", "fp16"),
            "rss_mb": round(_rss_mb(), 1),
        }

    def status(self) -> dict[str, Any]:
        return {
            "runtime_backend": "mlx",
            "runtime_backend_detail": self.name,
            "requested_runtime_backend": "mlx",
            "runtime_fallback_reason": self.unavailable_reason,
            "ready": bool(getattr(self.shard, "gguf_backend_ready", False)) and bool(self.weights),
            "attention_backend": "mlx_metal" if self.available else None,
            "batch_forward": True,
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "linear_attn_backend": self.scan_backend_effective,
            "scan_backend": self.scan_backend_effective,
            "linear_attn_ready": bool(self.available) and bool(getattr(self.shard, "gguf_backend_ready", False)),
            "state_bytes": 0,
            "rss_mb": round(_rss_mb(), 1),
            "weight_dtype": "gguf_q4_lazy",
            "compute_dtype": os.environ.get("VRYX_MLX_COMPUTE_DTYPE", "fp16"),
            "q4_hidden_transport_supported": bool(self.available),
            "lazy_cache_bytes": int(getattr(self.weights, "cache_bytes", 0) or 0),
            "mapped_weight_sample_keys": list(self.weights.keys())[:40] if self.weights else [],
            "gguf_raw_mapped_samples": getattr(self.weights, "raw_mapped_samples", []),
            "gguf_raw_unmapped_samples": getattr(self.weights, "raw_unmapped_samples", []),
        }

    def capabilities(self) -> dict[str, Any]:
        return {
            "runtime_backend": "mlx",
            "runtime_backend_detail": self.name,
            "supports_mlx": self.available,
            "supports_vllm": False,
            "supports_q4_weights": self.available,
            "weight_quantization": "q4",
            "attention_backend": "mlx_metal" if self.available else None,
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "linear_attn_backend": self.scan_backend_effective,
            "scan_backend": self.scan_backend_effective,
            "flash_attention": self.available,
            "linear_attn_ready": bool(self.available) and bool(getattr(self.shard, "gguf_backend_ready", False)),
            "batch_forward": True,
            "paged_kv_cache": False,
            "compute_dtype": os.environ.get("VRYX_MLX_COMPUTE_DTYPE", "fp16"),
            "q4_hidden_transport_supported": bool(self.available),
        }

    def unload(self) -> None:
        try:
            self.weights.clear()
        except Exception:
            pass
        self.kv_cache = None
        self.linear_states = None
        if self.mx is not None:
            _mlx_clear_cache(self.mx)
        if _STATE_ALLOCATOR is not None:
            _STATE_ALLOCATOR.release(self.shard.session_id)
