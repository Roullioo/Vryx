#!/usr/bin/env python3
"""Smoke MLX GGUF prefetch + first/second forward timing through the VPS API."""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def _post(url: str, payload: dict[str, Any], timeout: float) -> tuple[int, dict[str, Any], int]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", errors="replace")), int((time.perf_counter() - started) * 1000)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"ok": False, "error": raw[:2000]}
        return exc.code, parsed, int((time.perf_counter() - started) * 1000)
    except (TimeoutError, socket.timeout) as exc:
        return 599, {"ok": False, "error": f"http_timeout:{exc}"}, int((time.perf_counter() - started) * 1000)
    except Exception as exc:
        return 598, {"ok": False, "error": f"http_error:{type(exc).__name__}:{exc}"}, int((time.perf_counter() - started) * 1000)


def _trace(data: dict[str, Any]) -> dict[str, Any]:
    trace = data.get("pipeline_trace")
    return trace if isinstance(trace, dict) else {}


def _worker_rows(trace: dict[str, Any]) -> list[dict[str, Any]]:
    session_id = str(trace.get("session_id") or "")
    rows: list[dict[str, Any]] = []
    statuses = trace.get("worker_statuses") if isinstance(trace.get("worker_statuses"), list) else []
    for status in statuses:
        if not isinstance(status, dict):
            continue
        peer = str(status.get("peer_id") or status.get("peer") or status.get("peerId") or "")
        shards = status.get("shards") if isinstance(status.get("shards"), list) else []
        shard = next((item for item in shards if isinstance(item, dict) and item.get("session_id") == session_id), None)
        if not isinstance(shard, dict):
            continue
        rows.append({
            "peer_id": peer[-12:] if peer else "",
            "layers": f"{shard.get('layer_start')}-{shard.get('layer_end')}",
            "ready": bool(shard.get("ready")),
            "runtime_backend": shard.get("runtime_backend"),
            "runtime_backend_detail": shard.get("runtime_backend_detail"),
            "attention_backend": shard.get("attention_backend"),
            "linear_attn_ready": shard.get("linear_attn_ready"),
            "last_forward_ms": shard.get("last_forward_ms"),
            "gguf_prefetch_enabled": shard.get("gguf_prefetch_enabled"),
            "gguf_prefetch_ms": shard.get("gguf_prefetch_ms"),
            "gguf_prefetch_bytes": shard.get("gguf_prefetch_bytes"),
            "gguf_prefetch_tensor_count": shard.get("gguf_prefetch_tensor_count"),
            "first_forward_lazy_misses": shard.get("first_forward_lazy_misses"),
            "first_forward_lazy_read_ms": shard.get("first_forward_lazy_read_ms"),
            "first_forward_dequant_ms": shard.get("first_forward_dequant_ms"),
            "local_cache_hit_rate": shard.get("local_cache_hit_rate"),
            "local_source_path_present": shard.get("local_source_path_present"),
            "local_source_required": shard.get("local_source_required"),
            "local_source_error": shard.get("local_source_error"),
        })
    return rows


def _summary(label: str, status: int, data: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    trace = _trace(data)
    bench = trace.get("benchmark") if isinstance(trace.get("benchmark"), dict) else {}
    workers = _worker_rows(trace)
    return {
        "label": label,
        "ok": bool(data.get("ok")) and status < 400,
        "http_status": status,
        "client_wall_ms": wall_ms,
        "latency_ms": data.get("latency_ms"),
        "completion_tokens": data.get("completion_tokens"),
        "session_id": trace.get("session_id"),
        "session_reused": trace.get("session_reused"),
        "session_reuse_reason": trace.get("session_reuse_reason"),
        "shard_init_calls": trace.get("shard_init_calls"),
        "decode_tps": bench.get("decode_only_tps") or bench.get("actual_tps"),
        "ttft_ms": bench.get("ttft_ms"),
        "prefill_ms": bench.get("prefill_ms"),
        "workers": workers,
        "error": data.get("error"),
    }


def main() -> int:
    url = os.environ.get("VRYX_MLX_PREFETCH_SMOKE_URL", "http://127.0.0.1:3031/api/chat")
    timeout = float(os.environ.get("VRYX_MLX_PREFETCH_SMOKE_TIMEOUT", "900"))
    prompt = os.environ.get("VRYX_MLX_PREFETCH_SMOKE_PROMPT", "Réponds uniquement: OK prefetch.")
    base_payload = {
        "prompt": prompt,
        "max_new_tokens": int(os.environ.get("VRYX_MLX_PREFETCH_SMOKE_TOKENS", "1")),
        "quantization": os.environ.get("VRYX_MLX_PREFETCH_SMOKE_QUANT", "q4"),
        "pool_preference": os.environ.get("VRYX_MLX_PREFETCH_SMOKE_POOL", "auto"),
        "force_distributed": True,
        "load_mode": "shard",
        "chain_stream": False,
        "chain_result_direct": False,
        "decode_microbatch_cap": 1,
        "temperature": 0,
    }
    first_status, first_data, first_wall = _post(url, base_payload, timeout)
    first = _summary("first_forward", first_status, first_data, first_wall)
    if not first["ok"] and os.environ.get("VRYX_MLX_PREFETCH_SMOKE_RUN_SECOND_ON_FIRST_FAIL", "0").strip().lower() not in ("1", "true", "yes", "on"):
        result = {
            "ok": False,
            "first": first,
            "second": None,
            "failures": [f"first_failed:{first.get('error') or first_status}"],
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
        return 1
    second_status, second_data, second_wall = _post(url, base_payload, timeout)
    second = _summary("second_forward", second_status, second_data, second_wall)
    failures: list[str] = []
    if not first["ok"]:
        failures.append(f"first_failed:{first.get('error') or first_status}")
    if not second["ok"]:
        failures.append(f"second_failed:{second.get('error') or second_status}")
    if second.get("session_reused") is not True:
        failures.append("second_not_hot_path")
    require_local = os.environ.get("VRYX_MLX_PREFETCH_SMOKE_REQUIRE_LOCAL_SOURCE", "0").strip().lower() in ("1", "true", "yes", "on")
    for row in second.get("workers") or []:
        if row.get("runtime_backend") != "mlx":
            failures.append(f"{row.get('peer_id')}:runtime={row.get('runtime_backend')}")
        if row.get("attention_backend") != "mlx_metal":
            failures.append(f"{row.get('peer_id')}:attention={row.get('attention_backend')}")
        if row.get("linear_attn_ready") is not True:
            failures.append(f"{row.get('peer_id')}:linear_attn_ready={row.get('linear_attn_ready')}")
        if require_local and row.get("local_source_path_present") is not True:
            failures.append(f"{row.get('peer_id')}:local_source_missing:{row.get('local_source_error')}")
    result = {"ok": not failures, "first": first, "second": second, "failures": failures}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
