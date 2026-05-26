#!/usr/bin/env python3
"""Fail-fast smoke for the real MLX/Metal shard-only runtime."""

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
    if isinstance(data.get("pipeline_trace"), dict):
        return data["pipeline_trace"]
    if isinstance(data.get("trace"), dict):
        return data["trace"]
    return {}


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
        diag = shard.get("runtime_diagnostics") if isinstance(shard.get("runtime_diagnostics"), dict) else {}
        rows.append({
            "peer_id": peer,
            "session_id": shard.get("session_id"),
            "ready": bool(shard.get("ready") or shard.get("built")),
            "layers": f"{shard.get('layer_start')}-{shard.get('layer_end')}",
            "runtime_backend": shard.get("runtime_backend"),
            "runtime_backend_detail": shard.get("runtime_backend_detail"),
            "requested_runtime_backend": shard.get("requested_runtime_backend"),
            "attention_backend": shard.get("attention_backend"),
            "linear_attn_ready": bool(shard.get("linear_attn_ready")),
            "linear_attn_backend": shard.get("linear_attn_backend"),
            "scan_backend": shard.get("scan_backend"),
            "compute_dtype": shard.get("compute_dtype"),
            "fallback_reason": shard.get("runtime_fallback_reason"),
            "mlx_import_ok": diag.get("mlx_import_ok"),
            "mlx_version": diag.get("mlx_version"),
            "metal_available": diag.get("metal_available"),
            "hidden_transport": shard.get("hidden_transport"),
            "weight_quantization": shard.get("weight_quantization"),
        })
    return rows


def _summary(status: int, data: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    trace = _trace(data)
    pool = trace.get("pool_validation") if isinstance(trace.get("pool_validation"), dict) else {}
    rows = _worker_rows(trace)
    expected_peers = int(os.environ.get("VRYX_MLX_SHARD_SMOKE_EXPECT_PEERS", "2"))
    failures: list[str] = []
    if status >= 400 or not data.get("ok"):
        failures.append(f"request_failed:{status}:{data.get('error')}")
    if not pool.get("ready"):
        failures.append(f"pool_not_ready:{pool.get('fallback_reason')}")
    if len(rows) < expected_peers:
        failures.append(f"worker_rows_missing:{len(rows)}<{expected_peers}")
    for row in rows:
        peer = str(row.get("peer_id") or "unknown")[-8:]
        if row.get("runtime_backend") != "mlx":
            failures.append(f"{peer}:runtime_backend={row.get('runtime_backend')}")
        if row.get("attention_backend") != "mlx_metal":
            failures.append(f"{peer}:attention_backend={row.get('attention_backend')}")
        if row.get("linear_attn_ready") is not True:
            failures.append(f"{peer}:linear_attn_ready=false")
        if row.get("fallback_reason"):
            failures.append(f"{peer}:fallback_reason={row.get('fallback_reason')}")
        if row.get("mlx_import_ok") is not True:
            failures.append(f"{peer}:mlx_import_ok={row.get('mlx_import_ok')}")
        if row.get("metal_available") is not True:
            failures.append(f"{peer}:metal_available={row.get('metal_available')}")
    pool_fallback = pool.get("fallback_reason")
    if pool_fallback:
        failures.append(f"pool_fallback_reason={pool_fallback}")
    return {
        "ok": not failures,
        "http_status": status,
        "client_wall_ms": wall_ms,
        "session_id": trace.get("session_id"),
        "session_reused": trace.get("session_reused"),
        "session_reuse_reason": trace.get("session_reuse_reason"),
        "ready_workers": pool.get("ready_workers"),
        "worker_count": pool.get("worker_count"),
        "requested_pool_class": pool.get("requested_pool_class"),
        "actual_pool_class": pool.get("actual_pool_class"),
        "pool_fallback_reason": pool_fallback,
        "runtime_backend_per_worker": pool.get("runtime_backend_per_worker"),
        "attention_backend_per_worker": pool.get("attention_backend_per_worker"),
        "linear_attn_ready_per_worker": pool.get("linear_attn_ready_per_worker"),
        "workers": rows,
        "failures": failures,
    }


def main() -> int:
    url = os.environ.get("VRYX_MLX_SHARD_SMOKE_URL", "http://127.0.0.1:3031/api/chat")
    timeout = float(os.environ.get("VRYX_MLX_SHARD_SMOKE_TIMEOUT", "420"))
    payload = {
        "prompt": os.environ.get("VRYX_MLX_SHARD_SMOKE_PROMPT", "warmup mlx shard runtime"),
        "max_new_tokens": int(os.environ.get("VRYX_MLX_SHARD_SMOKE_TOKENS", "0")),
        "quantization": os.environ.get("VRYX_MLX_SHARD_SMOKE_QUANT", "q4"),
        "pool_preference": os.environ.get("VRYX_MLX_SHARD_SMOKE_POOL", "auto"),
        "force_distributed": True,
        "load_mode": "shard",
        "chain_stream": False,
        "chain_result_direct": False,
        "decode_microbatch_cap": 1,
        "warmup_only": True,
        "options": {"warmup_only": True},
    }
    status, data, wall_ms = _post(url, payload, timeout)
    summary = _summary(status, data, wall_ms)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
