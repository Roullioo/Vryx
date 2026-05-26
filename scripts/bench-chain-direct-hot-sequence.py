#!/usr/bin/env python3
"""Validate direct chain decode on a hot pipeline session.

Sequence:
  warmup stable (chain disabled per request)
  direct1, direct2, direct4, direct8, direct12 (chain direct enabled per request)

The script stops with ``not_hot_path`` as soon as a direct run is not backed by a
reused session or if shard init/load/build appears on the hot path.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _post_chat(url: str, payload: dict[str, Any], timeout: float) -> tuple[int, dict[str, Any], int]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw), int((time.perf_counter() - started) * 1000)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"ok": False, "error": raw[:2000]}
        return exc.code, parsed, int((time.perf_counter() - started) * 1000)


def _trace(data: dict[str, Any]) -> dict[str, Any]:
    return data.get("pipeline_trace") if isinstance(data.get("pipeline_trace"), dict) else {}


def _perf(data: dict[str, Any]) -> dict[str, Any]:
    trace = _trace(data)
    return trace.get("perf_trace") if isinstance(trace.get("perf_trace"), dict) else {}


def _chain_hops(data: dict[str, Any]) -> list[dict[str, Any]]:
    perf = _perf(data)
    rows: list[dict[str, Any]] = []
    for token in perf.get("per_token") or []:
        if not isinstance(token, dict):
            continue
        for hop in token.get("hop_traces") or []:
            if not isinstance(hop, dict) or not hop.get("chain_result_direct"):
                continue
            relay_trace = hop.get("relay_trace") if isinstance(hop.get("relay_trace"), dict) else {}
            rows.append(
                {
                    "step_id": relay_trace.get("step_id", token.get("step")),
                    "request_id": relay_trace.get("request_id"),
                    "pending_key": hop.get("pending_key") or relay_trace.get("pending_key"),
                    "pending_count_before": hop.get("pending_count_before") or relay_trace.get("pending_count_before"),
                    "pending_count_after": hop.get("pending_count_after") or relay_trace.get("pending_count_after"),
                    "stream_reused": hop.get("stream_reused"),
                    "stream_closed": hop.get("stream_closed") or relay_trace.get("stream_closed"),
                    "chain_forward_ms": hop.get("chain_forward_ms"),
                    "chain_ack_ms": hop.get("chain_ack_ms"),
                    "chain_result_wait_ms": hop.get("chain_result_wait_ms"),
                    "chain_result_from_peer": hop.get("chain_result_from_peer"),
                    "m1_compute_ms": hop.get("m1_compute_ms"),
                    "m4_compute_ms": hop.get("m4_compute_ms"),
                    "fallback_used": hop.get("fallback_used"),
                    "fallback_reason": hop.get("fallback_reason"),
                    "failed_step_id": hop.get("failed_step_id") or relay_trace.get("failed_step_id"),
                    "failed_stage": hop.get("failed_stage") or relay_trace.get("failed_stage"),
                    "failed_peer": hop.get("failed_peer") or relay_trace.get("failed_peer"),
                    "transport_error_detail": hop.get("transport_error_detail") or relay_trace.get("transport_error_detail"),
                }
            )
    return rows


def _summary(label: str, tokens: int, status: int, data: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    trace = _trace(data)
    perf = _perf(data)
    chain_hops = _chain_hops(data)
    return {
        "label": label,
        "tokens_requested": tokens,
        "http_status": status,
        "ok": bool(data.get("ok")) and status < 400,
        "completion_tokens": data.get("completion_tokens"),
        "client_wall_ms": wall_ms,
        "session_id": trace.get("session_id"),
        "session_reused": trace.get("session_reused"),
        "session_reuse_reason": trace.get("session_reuse_reason"),
        "shard_init_calls": perf.get("shard_init_calls"),
        "shard_load_calls": perf.get("shard_load_calls"),
        "shard_build_calls": perf.get("shard_build_calls"),
        "chain_stream_used": perf.get("chain_stream_used"),
        "chain_result_direct": perf.get("chain_result_direct"),
        "fallback_used": perf.get("fallback_used"),
        "fallback_reason": perf.get("fallback_reason"),
        "request_response_fallback": perf.get("request_response_fallback"),
        "failed_step_id": perf.get("failed_step_id"),
        "failed_stage": perf.get("failed_stage"),
        "failed_peer": perf.get("failed_peer"),
        "transport_error_detail": perf.get("transport_error_detail"),
        "global_tps": perf.get("global_tps"),
        "decode_tps": perf.get("decode_tps"),
        "m1_compute_ms": perf.get("m1_compute_ms"),
        "m4_compute_ms": perf.get("m4_compute_ms"),
        "chain_forward_ms": perf.get("chain_forward_ms"),
        "chain_ack_ms": perf.get("chain_ack_ms"),
        "chain_result_wait_ms": perf.get("chain_result_wait_ms"),
        "chain_hops": chain_hops,
        "error": data.get("error"),
    }


def _is_hot(summary: dict[str, Any]) -> bool:
    return (
        summary.get("session_reused") is True
        and int(summary.get("shard_init_calls") or 0) == 0
        and int(summary.get("shard_load_calls") or 0) == 0
        and int(summary.get("shard_build_calls") or 0) == 0
    )


def main() -> int:
    url = os.environ.get("VRYX_CHAIN_BENCH_URL", "http://127.0.0.1:3031/api/chat").rstrip("/")
    timeout = _env_float("VRYX_CHAIN_BENCH_TIMEOUT", 240.0)
    prompt = os.environ.get(
        "VRYX_CHAIN_BENCH_PROMPT",
        "Continue with short comma-separated numbers only: 1, 2, 3, 4,",
    )
    sequence = [int(x) for x in os.environ.get("VRYX_CHAIN_BENCH_SEQUENCE", "1,2,4,8,12").split(",") if x.strip()]
    common = {
        "prompt": prompt,
        "temperature": 0,
        "quantization": os.environ.get("VRYX_CHAIN_BENCH_QUANT", "fp16"),
        "pool_preference": os.environ.get("VRYX_CHAIN_BENCH_POOL", "auto"),
        "force_distributed": True,
    }

    warmup_tokens = int(os.environ.get("VRYX_CHAIN_BENCH_WARMUP_TOKENS", "2"))
    status, data, wall_ms = _post_chat(
        url,
        {**common, "max_new_tokens": warmup_tokens, "chain_stream": False, "chain_result_direct": False},
        timeout,
    )
    warmup = _summary("warmup_stable_no_chain", warmup_tokens, status, data, wall_ms)
    print(json.dumps(warmup, ensure_ascii=False, sort_keys=True), flush=True)
    if not warmup["ok"]:
        print(json.dumps({"ok": False, "error": "warmup_failed", "warmup": warmup}, ensure_ascii=False, sort_keys=True), flush=True)
        return 1

    for tokens in sequence:
        label = f"direct{tokens}"
        status, data, wall_ms = _post_chat(
            url,
            {**common, "max_new_tokens": tokens, "chain_stream": True, "chain_result_direct": True},
            timeout,
        )
        summary = _summary(label, tokens, status, data, wall_ms)
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)

        if not _is_hot(summary):
            print(json.dumps({"ok": False, "error": "not_hot_path", "failed_label": label, "summary": summary}, ensure_ascii=False, sort_keys=True), flush=True)
            return 3
        if not summary["ok"]:
            print(json.dumps({"ok": False, "error": "direct_run_failed", "failed_label": label, "summary": summary}, ensure_ascii=False, sort_keys=True), flush=True)
            return 1
        if tokens >= 2:
            if summary.get("chain_stream_used") is not True or summary.get("chain_result_direct") is not True:
                print(json.dumps({"ok": False, "error": "chain_not_used", "failed_label": label, "summary": summary}, ensure_ascii=False, sort_keys=True), flush=True)
                return 4
            if summary.get("fallback_used") or summary.get("request_response_fallback"):
                print(json.dumps({"ok": False, "error": "fallback_used", "failed_label": label, "summary": summary}, ensure_ascii=False, sort_keys=True), flush=True)
                return 5

    print(json.dumps({"ok": True, "sequence": sequence}, ensure_ascii=False, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
