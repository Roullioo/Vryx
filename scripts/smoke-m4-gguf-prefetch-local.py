#!/usr/bin/env python3
"""Strict local M4 GGUF/MLX prefetch smoke.

Runs inside the worker Python process context, without the VPS warmup/duo path:
  1. shard.init with a GGUF manifest download_url
  2. build + prefetch
  3. forward1
  4. forward2

The goal is to prove that prefetch fills the exact dequantized cache used by
forward, so forward1/forward2 do not pay GGUF lazy misses/dequant again.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import time
from typing import Any

import numpy as np


ROOT = pathlib.Path(
    os.environ.get(
        "VRYX_PYTHON_INFERENCE_ROOT",
        str(pathlib.Path(__file__).resolve().parents[1] / "nodeAndWorker" / "python-inference"),
    )
)
sys.path.insert(0, str(ROOT))


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, str(default)) or default))
    except (TypeError, ValueError):
        return default


def _backend_status(shard: Any) -> dict[str, Any]:
    if getattr(shard, "backend", None) is None:
        return {}
    try:
        return dict(shard.backend.status())
    except Exception as exc:
        return {"status_error": f"{type(exc).__name__}:{exc}"}


def _compact_status(status: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "runtime_backend",
        "runtime_backend_detail",
        "attention_backend",
        "linear_attn_ready",
        "gguf_prefetch_enabled",
        "gguf_prefetch_in_progress",
        "gguf_prefetch_ms",
        "gguf_prefetch_tensor_count",
        "prefetch_required_tensor_count",
        "prefetch_cache_filled_count",
        "prefetch_cache_hit_count_after",
        "dequant_cache_count",
        "lazy_misses_after_prefetch",
        "first_forward_lazy_misses",
        "first_forward_dequant_ms",
        "first_forward_wall_ms",
        "second_forward_lazy_misses",
        "second_forward_dequant_ms",
        "second_forward_wall_ms",
        "last_forward_lazy_misses",
        "last_forward_dequant_ms",
        "last_forward_wall_ms",
        "lazy_cache_entries",
        "lazy_cache_bytes",
        "lazy_cache_max_bytes",
        "quantized_expert_path",
        "quantized_expert_count",
        "quantized_expert_cache_bytes",
        "expert_dense_cache_gib",
        "expert_cache_hit_count",
        "local_source_path_present",
        "local_source_required",
        "local_source_error",
        "forward_count",
    )
    return {key: status.get(key) for key in keys}


def _forward_payload(session_id: str, request_id: str, step: int, hidden_size: int) -> bytes:
    hidden = np.zeros((1, 1, hidden_size), dtype=np.float16)
    payload = {
        "session_id": session_id,
        "request_id": request_id,
        "step": step,
        "seq_pos": step,
        "decode_mode": "single_token_stateful" if step > 0 else "prefill_full_context",
        "use_kv_cache": False,
        "hidden_fp16_b64": base64.b64encode(hidden.tobytes()).decode("ascii"),
        "hidden_shape": list(hidden.shape),
        "hidden_dtype": "fp16",
        "hidden_transport": "fp16",
        "history_token_ids": [1],
        "token_ids": [1],
        "sampling": {"temperature": 0},
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def main() -> int:
    os.environ.setdefault("VRYX_RUNTIME_BACKEND", "mlx")
    os.environ.setdefault("VRYX_ENABLE_MLX_RUNTIME", "1")
    os.environ.setdefault("VRYX_ENABLE_MLX_KERNELS", "1")
    os.environ.setdefault("VRYX_MLX_SCAN_BACKEND", "metal")
    os.environ.setdefault("VRYX_MLX_COMPUTE_DTYPE", "fp16")
    os.environ.setdefault("VRYX_MLX_STRICT", "1")
    os.environ.setdefault("VRYX_DISABLE_PYTORCH_FALLBACK", "1")
    os.environ.setdefault("VRYX_ENABLE_GGUF_MLX_SHARD", "1")
    os.environ.setdefault("VRYX_MLX_PREFETCH_SHARD_WEIGHTS", "1")
    os.environ.setdefault("VRYX_MLX_PREFETCH_ON_BUILD", "1")
    os.environ.setdefault("VRYX_GGUF_PREFETCH_PIN_DEQUANTIZED", "1")
    os.environ.setdefault("VRYX_MLX_LAYER_TRACE", "1")
    os.environ.setdefault("VRYX_MLX_MOE_TOPK_ONLY", "1")
    os.environ.setdefault("VRYX_MLX_MOE_QUANTIZED_EXPERTS", "1")
    os.environ.setdefault("VRYX_MLX_MOE_EXPERT_DEQUANT_MODE", "block")
    os.environ.setdefault("VRYX_MLX_MOE_EXPERT_CACHE_POLICY", "selected_lru")
    os.environ.setdefault("VRYX_GGUF_REQUIRE_LOCAL_SOURCE", "1")
    os.environ.setdefault("VRYX_GGUF_PERF_MODE", "1")

    import shard_runtime  # noqa: WPS433

    download_url = os.environ.get("VRYX_M4_GGUF_MANIFEST_URL", "").strip()
    if not download_url:
        print(json.dumps({"ok": False, "error": "missing VRYX_M4_GGUF_MANIFEST_URL"}), flush=True)
        return 2

    session_id = os.environ.get("VRYX_M4_PREFETCH_SMOKE_SESSION", f"m4-local-prefetch-{int(time.time())}")
    hidden_size = _env_int("VRYX_M4_HIDDEN_SIZE", 2048)
    layer_start = _env_int("VRYX_M4_LAYER_START", 2)
    layer_end = _env_int("VRYX_M4_LAYER_END", 39)
    required_expected = _env_int("VRYX_M4_GGUF_REQUIRED_TENSOR_COUNT", 674)
    first_dequant_limit_ms = _env_int("VRYX_M4_FIRST_DEQUANT_LIMIT_MS", 5000)
    second_wall_limit_ms = _env_int("VRYX_M4_SECOND_FORWARD_LIMIT_MS", 5000)

    meta = {
        "session_id": session_id,
        "pool_id": "m4-local-prefetch-smoke",
        "model_id": os.environ.get("VRYX_M4_MODEL_ID", "Qwen/Qwen3.6-35B-A3B"),
        "download_url": download_url,
        "async_load": False,
        "layer_start": layer_start,
        "layer_end": layer_end,
        "has_embedding": False,
        "has_lm_head": True,
        "ttl_sec": _env_int("VRYX_M4_PREFETCH_SMOKE_TTL_SEC", 3600),
        "runtime_backend": "mlx",
        "weight_quantization": "q4",
        "supports_mlx": True,
        "supports_q4_weights": True,
        "hidden_transport": "fp16",
        "model_config": {
            "model_type": "qwen3_moe",
            "num_hidden_layers": 40,
            "hidden_size": hidden_size,
            "num_attention_heads": 32,
            "num_key_value_heads": 8,
            "intermediate_size": 6144,
            "vocab_size": 151936,
            "head_dim": 128,
            "rope_theta": 1_000_000.0,
            "max_position_embeddings": 32768,
        },
    }

    build_t0 = time.perf_counter()
    init_raw = shard_runtime.pipeline_shard_init(json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    init = json.loads(init_raw)
    build_wall_ms = int((time.perf_counter() - build_t0) * 1000)
    shard = shard_runtime._shards.get(session_id)
    after_build = _backend_status(shard) if shard is not None else {}

    forward1 = {}
    forward2 = {}
    after_forward1 = {}
    after_forward2 = {}
    if init.get("ok") and shard is not None:
        raw1 = shard_runtime.pipeline_shard_forward(_forward_payload(session_id, f"{session_id}-f1", 0, hidden_size), session_id)
        forward1 = json.loads(raw1.decode("utf-8", errors="replace"))
        after_forward1 = _backend_status(shard)
        raw2 = shard_runtime.pipeline_shard_forward(_forward_payload(session_id, f"{session_id}-f2", 1, hidden_size), session_id)
        forward2 = json.loads(raw2.decode("utf-8", errors="replace"))
        after_forward2 = _backend_status(shard)

    trace1 = forward1.get("transport_trace") if isinstance(forward1.get("transport_trace"), dict) else {}
    trace2 = forward2.get("transport_trace") if isinstance(forward2.get("transport_trace"), dict) else {}
    layers2 = trace2.get("layer_trace") if isinstance(trace2.get("layer_trace"), list) else []
    top_slowest2 = trace2.get("top_slowest_layers") if isinstance(trace2.get("top_slowest_layers"), list) else []
    moe_ms2 = sum(int(row.get("moe_total_ms") or 0) for row in layers2 if isinstance(row, dict))
    attention_ms2 = sum(int(row.get("attention_ms") or 0) for row in layers2 if isinstance(row, dict))
    expert_ms2 = sum(int(row.get("expert_matmul_ms") or 0) for row in layers2 if isinstance(row, dict))
    expert_q_ms2 = sum(int(row.get("expert_quantized_matmul_ms") or 0) for row in layers2 if isinstance(row, dict))
    expert_block_dequant_ms2 = sum(int(row.get("expert_block_dequant_ms") or 0) for row in layers2 if isinstance(row, dict))
    shared_ms2 = sum(int(row.get("shared_expert_ms") or 0) for row in layers2 if isinstance(row, dict))
    dense_fallback_layers2 = [
        row.get("layer_id")
        for row in layers2
        if isinstance(row, dict) and row.get("expert_dense_fallback")
    ]
    experts_computed2 = [
        {
            "layer_id": row.get("layer_id"),
            "selected_experts_count": row.get("selected_experts_count"),
            "top_k": row.get("top_k"),
            "experts_total": row.get("experts_total"),
            "expert_batched": row.get("expert_batched"),
        }
        for row in layers2[:10]
        if isinstance(row, dict)
    ]

    failures: list[str] = []
    if not init.get("ok"):
        failures.append(f"init_failed:{init.get('error')}")
    if shard is None:
        failures.append("session_missing_after_init")

    final_status = after_forward2 or after_forward1 or after_build
    required = int(final_status.get("prefetch_required_tensor_count") or 0)
    filled = int(final_status.get("prefetch_cache_filled_count") or 0)
    cache_hits_after = int(final_status.get("prefetch_cache_hit_count_after") or 0)
    dequant_cache_count = int(final_status.get("dequant_cache_count") or 0)
    first_misses = int(final_status.get("first_forward_lazy_misses") or 0)
    first_dequant = int(final_status.get("first_forward_dequant_ms") or 0)
    second_misses = int(final_status.get("second_forward_lazy_misses") or 0)
    second_dequant = int(final_status.get("second_forward_dequant_ms") or 0)
    second_wall = int(final_status.get("second_forward_wall_ms") or 0)

    if final_status.get("runtime_backend") != "mlx":
        failures.append(f"runtime_backend={final_status.get('runtime_backend')}")
    if final_status.get("attention_backend") != "mlx_metal":
        failures.append(f"attention_backend={final_status.get('attention_backend')}")
    if final_status.get("linear_attn_ready") is not True:
        failures.append(f"linear_attn_ready={final_status.get('linear_attn_ready')}")
    if required_expected > 0 and required != required_expected:
        failures.append(f"required_tensor_count={required},expected={required_expected}")
    if required > 0 and filled < required:
        failures.append(f"prefetch_cache_filled_count={filled}/{required}")
    if required > 0 and cache_hits_after < required:
        failures.append(f"prefetch_cache_hit_count_after={cache_hits_after}/{required}")
    if required > 0 and dequant_cache_count < required:
        failures.append(f"dequant_cache_count={dequant_cache_count}/{required}")
    if first_misses != 0:
        failures.append(f"first_forward_lazy_misses={first_misses}")
    if first_dequant > first_dequant_limit_ms:
        failures.append(f"first_forward_dequant_ms={first_dequant}>{first_dequant_limit_ms}")
    if second_misses != 0:
        failures.append(f"second_forward_lazy_misses={second_misses}")
    if second_dequant != 0:
        failures.append(f"second_forward_dequant_ms={second_dequant}")
    if second_wall_limit_ms > 0 and second_wall > second_wall_limit_ms:
        failures.append(f"second_forward_wall_ms={second_wall}>{second_wall_limit_ms}")
    expert_dense_cache_gib = float((trace2 or {}).get("expert_dense_cache_gib") or 0.0)
    if dense_fallback_layers2:
        failures.append(f"expert_dense_fallback_layers={dense_fallback_layers2[:10]}")
    if expert_dense_cache_gib >= float(os.environ.get("VRYX_M4_EXPERT_DENSE_CACHE_LIMIT_GIB", "10")):
        failures.append(f"expert_dense_cache_gib={expert_dense_cache_gib}")
    if forward1 and forward1.get("ok") is False:
        failures.append(f"forward1_failed:{forward1.get('error')}")
    if forward2 and forward2.get("ok") is False:
        failures.append(f"forward2_failed:{forward2.get('error')}")

    result = {
        "ok": not failures,
        "session_id": session_id,
        "build_wall_ms": build_wall_ms,
        "init": init,
        "after_build": _compact_status(after_build),
        "forward1": {
            "ok": forward1.get("ok"),
            "compute_time_ms": forward1.get("compute_time_ms"),
            "error": forward1.get("error"),
            "memory": {
                "memory_before_forward_mb": trace1.get("memory_before_forward_mb"),
                "memory_after_forward_mb": trace1.get("memory_after_forward_mb"),
                "cache_dense_gib": trace1.get("cache_dense_gib"),
                "expert_cache_gib": trace1.get("expert_cache_gib"),
                "active_expert_cache_gib": trace1.get("active_expert_cache_gib"),
                "expert_dense_cache_gib": trace1.get("expert_dense_cache_gib"),
                "peak_memory_gib": trace1.get("peak_memory_gib"),
            },
        },
        "after_forward1": _compact_status(after_forward1),
        "forward2": {
            "ok": forward2.get("ok"),
            "compute_time_ms": forward2.get("compute_time_ms"),
            "error": forward2.get("error"),
            "memory": {
                "memory_before_forward_mb": trace2.get("memory_before_forward_mb"),
                "memory_after_forward_mb": trace2.get("memory_after_forward_mb"),
                "cache_dense_gib": trace2.get("cache_dense_gib"),
                "expert_cache_gib": trace2.get("expert_cache_gib"),
                "active_expert_cache_gib": trace2.get("active_expert_cache_gib"),
                "expert_dense_cache_gib": trace2.get("expert_dense_cache_gib"),
                "peak_memory_gib": trace2.get("peak_memory_gib"),
            },
            "layer_trace_summary": {
                "layer_count": len(layers2),
                "moe_total_ms": moe_ms2,
                "attention_total_ms": attention_ms2,
                "expert_matmul_ms": expert_ms2,
                "expert_quantized_matmul_ms": expert_q_ms2,
                "expert_block_dequant_ms": expert_block_dequant_ms2,
                "expert_dense_fallback": bool(dense_fallback_layers2),
                "expert_dense_fallback_layers": dense_fallback_layers2[:10],
                "shared_expert_ms": shared_ms2,
                "top_slowest_layers": top_slowest2[:10],
                "experts_computed_sample": experts_computed2,
            },
        },
        "after_forward2": _compact_status(after_forward2),
        "failures": failures,
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
