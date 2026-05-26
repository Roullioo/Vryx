#!/usr/bin/env python3
"""Smoke Qwen3.6/Qwen3.5 MoE shard-only forward on a hot M1/M4 session."""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any


DEFAULT_PROMPTS = [
    "Answer with one short English word: sky color?",
    "Réponds avec un seul mot en français: couleur du ciel ?",
    "Continue with the next number only: 1 2 3",
]


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


def _perf(data: dict[str, Any]) -> dict[str, Any]:
    trace = _trace(data)
    if isinstance(trace.get("perf_trace"), dict):
        return trace["perf_trace"]
    return trace


def _calls(trace: dict[str, Any], perf: dict[str, Any]) -> dict[str, int]:
    raw = trace.get("call_counts") if isinstance(trace.get("call_counts"), dict) else {}
    return {
        "shard_init_calls": int(perf.get("shard_init_calls") or raw.get("vryx.shard.init") or 0),
        "shard_load_calls": int(perf.get("shard_load_calls") or raw.get("vryx.shard.load") or 0),
        "shard_build_calls": int(perf.get("shard_build_calls") or raw.get("vryx.shard.build") or 0),
    }


def _summary(label: str, prompt_idx: int, status: int, data: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    trace = _trace(data)
    perf = _perf(data)
    phase = trace.get("phase_trace") if isinstance(trace.get("phase_trace"), dict) else {}
    calls = _calls(trace, perf)
    completion_tokens = int(data.get("completion_tokens") or perf.get("completion_tokens") or 0)
    global_tps = perf.get("global_tps") or perf.get("e2e_tps")
    if not global_tps and wall_ms > 0 and completion_tokens > 0:
        global_tps = round(completion_tokens * 1000.0 / wall_ms, 3)
    row = {
        "label": label,
        "prompt_idx": prompt_idx,
        "http_status": status,
        "ok": bool(data.get("ok")) and status < 400,
        "error": data.get("error"),
        "text": str(data.get("response") or data.get("text") or "")[:160],
        "completion_tokens": completion_tokens,
        "client_wall_ms": wall_ms,
        "latency_ms": data.get("latency_ms"),
        "session_id": trace.get("session_id"),
        "session_reused": trace.get("session_reused"),
        "session_reuse_reason": trace.get("session_reuse_reason"),
        "routing_path": trace.get("routing_path"),
        "prefill_ms": perf.get("prefill_ms") or phase.get("prefill_ms"),
        "ttft_ms": perf.get("ttft_ms") or phase.get("ttft_ms"),
        "decode_total_ms": perf.get("decode_total_ms") or phase.get("decode_total_ms"),
        "decode_tps": perf.get("decode_tps"),
        "global_tps": global_tps,
        "m1_compute_ms": perf.get("m1_compute_ms"),
        "m4_compute_ms": perf.get("m4_compute_ms"),
        "relay_ms": perf.get("relay_ms") or perf.get("relay_total_ms"),
        "chain_stream_used": perf.get("chain_stream_used"),
        "chain_result_direct": perf.get("chain_result_direct"),
        "fallback_used": perf.get("fallback_used"),
        "request_response_fallback": perf.get("request_response_fallback"),
        **calls,
    }
    row["hot_path"] = (
        row["session_reused"] is True
        and row["shard_init_calls"] == 0
        and row["shard_load_calls"] == 0
        and row["shard_build_calls"] == 0
    )
    return row


def _emit(row: dict[str, Any]) -> None:
    print(json.dumps(row, ensure_ascii=False, sort_keys=True), flush=True)


def main() -> int:
    url = os.environ.get("VRYX_QWEN_FORWARD_SMOKE_URL", "http://127.0.0.1:3031/api/chat")
    timeout = float(os.environ.get("VRYX_QWEN_FORWARD_SMOKE_TIMEOUT", "240"))
    prompts_raw = os.environ.get("VRYX_QWEN_FORWARD_SMOKE_PROMPTS", "").strip()
    prompts = [p.strip() for p in prompts_raw.split("|||") if p.strip()] if prompts_raw else DEFAULT_PROMPTS
    direct = os.environ.get("VRYX_QWEN_FORWARD_SMOKE_DIRECT", "1").strip().lower() not in ("0", "false", "no", "off")
    token_sequence = [
        int(part.strip())
        for part in os.environ.get("VRYX_QWEN_FORWARD_SMOKE_TOKEN_SEQUENCE", "1,2").split(",")
        if part.strip()
    ]
    payload_base: dict[str, Any] = {
        "temperature": 0,
        "quantization": os.environ.get("VRYX_QWEN_FORWARD_SMOKE_QUANT", "q4"),
        "pool_preference": os.environ.get("VRYX_QWEN_FORWARD_SMOKE_POOL", "auto"),
        "load_mode": "shard",
        "force_distributed": True,
        "chain_stream": direct,
        "chain_result_direct": direct,
        "decode_microbatch_cap": 1,
    }
    failures = 0
    rows = []
    for tokens in token_sequence:
        for idx, prompt in enumerate(prompts):
            status, data, wall_ms = _post(url, {**payload_base, "prompt": prompt, "max_new_tokens": tokens}, timeout)
            row = _summary(f"direct{tokens}" if direct else f"stable{tokens}", idx, status, data, wall_ms)
            _emit(row)
            rows.append(row)
            if not row["ok"] or not row["hot_path"] or int(row.get("completion_tokens") or 0) <= 0:
                failures += 1
    ok_rows = [row for row in rows if row.get("ok")]
    summary = {
        "ok": failures == 0,
        "prompts": len(prompts),
        "token_sequence": token_sequence,
        "failures": failures,
        "avg_client_wall_ms": round(sum(float(r.get("client_wall_ms") or 0) for r in ok_rows) / len(ok_rows), 1) if ok_rows else 0,
        "avg_global_tps": round(sum(float(r.get("global_tps") or 0) for r in ok_rows) / len(ok_rows), 3) if ok_rows else 0,
        "avg_decode_tps": round(sum(float(r.get("decode_tps") or 0) for r in ok_rows) / len(ok_rows), 3) if ok_rows else 0,
    }
    _emit(summary)
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
