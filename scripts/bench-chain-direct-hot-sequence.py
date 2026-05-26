#!/usr/bin/env python3
"""Validate direct chain decode on a hot pipeline session.

Sequence:
  warmup stable (chain disabled per request)
  then configurable stable/direct runs.

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
import socket
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
    except (TimeoutError, socket.timeout) as exc:
        return 599, {"ok": False, "error": f"http_timeout:{exc}"}, int((time.perf_counter() - started) * 1000)
    except Exception as exc:
        return 598, {"ok": False, "error": f"http_error:{type(exc).__name__}:{exc}"}, int((time.perf_counter() - started) * 1000)


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
                    "microbatch_id": hop.get("microbatch_id"),
                    "microbatch_round": hop.get("micro_round"),
                    "token_start": hop.get("token_start"),
                    "token_count": hop.get("token_count"),
                    "request_id": relay_trace.get("request_id"),
                    "pending_key": hop.get("pending_key") or relay_trace.get("pending_key"),
                    "pending_count_before": hop.get("pending_count_before") or relay_trace.get("pending_count_before"),
                    "pending_count_after": hop.get("pending_count_after") or relay_trace.get("pending_count_after"),
                    "stream_reused": hop.get("stream_reused"),
                    "stream_closed": hop.get("stream_closed") or relay_trace.get("stream_closed"),
                    "chain_forward_ms": hop.get("chain_forward_ms"),
                    "chain_ack_ms": hop.get("chain_ack_ms"),
                    "chain_result_wait_ms": hop.get("chain_result_wait_ms"),
                    "payload_bytes": hop.get("chain_payload_bytes") or hop.get("request_payload_bytes") or relay_trace.get("payload_bytes"),
                    "chain_result_from_peer": hop.get("chain_result_from_peer"),
                    "m1_compute_ms": hop.get("m1_compute_ms"),
                    "m4_compute_ms": hop.get("m4_compute_ms"),
                    "coalesced": hop.get("coalesced") or relay_trace.get("coalesced"),
                    "batch_hop_count": hop.get("batch_hop_count") or relay_trace.get("batch_hop_count"),
                    "batch_m1_compute_ms": hop.get("batch_m1_compute_ms") or relay_trace.get("batch_m1_compute_ms"),
                    "batch_m4_compute_ms": hop.get("batch_m4_compute_ms") or relay_trace.get("batch_m4_compute_ms"),
                    "batch_chain_forward_ms": hop.get("batch_chain_forward_ms") or relay_trace.get("batch_chain_forward_ms"),
                    "batch_result_wait_ms": hop.get("batch_result_wait_ms") or relay_trace.get("batch_result_wait_ms"),
                    "batch_tokens_per_second": hop.get("batch_tokens_per_second") or relay_trace.get("batch_tokens_per_second"),
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
    pending_keys = [str(h.get("pending_key") or "") for h in chain_hops if h.get("pending_key")]
    microbatch_ids = [str(h.get("microbatch_id") or "") for h in chain_hops if h.get("microbatch_id")]
    m1_compute = int(perf.get("m1_compute_ms") or 0)
    m4_compute = int(perf.get("m4_compute_ms") or 0)
    effective_chain_hop_count = sum(int(h.get("batch_hop_count") or 1) for h in chain_hops)
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
        "m1_bottleneck": bool(m1_compute > max(m4_compute, 0) * 1.15 and m1_compute > 0),
        "chain_forward_ms": perf.get("chain_forward_ms"),
        "chain_ack_ms": perf.get("chain_ack_ms"),
        "chain_result_wait_ms": perf.get("chain_result_wait_ms"),
        "chain_hops": chain_hops,
        "chain_hop_count": effective_chain_hop_count,
        "raw_chain_frame_count": len(chain_hops),
        "coalesced": any(bool(h.get("coalesced")) for h in chain_hops),
        "duplicate_pending": len(pending_keys) != len(set(pending_keys)),
        "duplicate_microbatch": len(microbatch_ids) != len(set(microbatch_ids)),
        "error": data.get("error"),
    }


def _is_hot(summary: dict[str, Any]) -> bool:
    return (
        summary.get("session_reused") is True
        and int(summary.get("shard_init_calls") or 0) == 0
        and int(summary.get("shard_load_calls") or 0) == 0
        and int(summary.get("shard_build_calls") or 0) == 0
    )


def _emit(row: dict[str, Any]) -> None:
    trace_file = os.environ.get("VRYX_CHAIN_BENCH_TRACE_FILE", "").strip()
    if trace_file:
        with open(trace_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    if os.environ.get("VRYX_CHAIN_BENCH_VERBOSE", "0").strip().lower() in ("1", "true", "yes", "on"):
        print(json.dumps(row, ensure_ascii=False, sort_keys=True), flush=True)
        return
    compact = dict(row)
    if isinstance(compact.get("chain_hops"), list):
        compact["chain_hops_sample"] = compact["chain_hops"][:3]
        compact.pop("chain_hops", None)
    print(json.dumps(compact, ensure_ascii=False, sort_keys=True), flush=True)


def main() -> int:
    url = os.environ.get("VRYX_CHAIN_BENCH_URL", "http://127.0.0.1:3031/api/chat").rstrip("/")
    timeout = _env_float("VRYX_CHAIN_BENCH_TIMEOUT", 240.0)
    prompt = os.environ.get(
        "VRYX_CHAIN_BENCH_PROMPT",
        "Print a long stream of the word alpha separated by spaces. Do not use punctuation. alpha alpha alpha alpha",
    )
    sequence = [int(x) for x in os.environ.get("VRYX_CHAIN_BENCH_SEQUENCE", "24,48,128").split(",") if x.strip()]
    caps = [int(x) for x in os.environ.get("VRYX_CHAIN_BENCH_CAPS", "8,16,32").split(",") if x.strip()]
    compare_stable = os.environ.get("VRYX_CHAIN_BENCH_COMPARE_STABLE", "1").strip().lower() not in ("0", "false", "no", "off")
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
    _emit(warmup)
    if not warmup["ok"]:
        _emit({"ok": False, "error": "warmup_failed", "warmup": warmup})
        return 1

    plan: list[dict[str, Any]] = []
    if compare_stable:
        for tokens in sequence:
            plan.append({
                "label": f"stable{tokens}",
                "tokens": tokens,
                "chain_stream": False,
                "chain_result_direct": False,
                "cap": None,
                "expect_chain": False,
            })
    for cap in caps:
        for tokens in sequence:
            plan.append({
                "label": f"direct{tokens}_cap{cap}",
                "tokens": tokens,
                "chain_stream": True,
                "chain_result_direct": True,
                "cap": cap,
                "expect_chain": tokens >= 2,
            })

    results: list[dict[str, Any]] = []
    for item in plan:
        tokens = int(item["tokens"])
        label = str(item["label"])
        payload = {
            **common,
            "max_new_tokens": tokens,
            "chain_stream": bool(item["chain_stream"]),
            "chain_result_direct": bool(item["chain_result_direct"]),
        }
        if item.get("cap") is not None:
            payload["decode_microbatch_cap"] = int(item["cap"])
        status, data, wall_ms = _post_chat(
            url,
            payload,
            timeout,
        )
        summary = _summary(label, tokens, status, data, wall_ms)
        summary["mode"] = "direct_chain_decode_only" if item["chain_stream"] else "stable_stream"
        summary["decode_microbatch_cap"] = item.get("cap")
        _emit(summary)
        results.append(summary)

        if not _is_hot(summary):
            _emit({"ok": False, "error": "not_hot_path", "failed_label": label, "summary": summary})
            return 3
        if not summary["ok"]:
            _emit({"ok": False, "error": "direct_run_failed", "failed_label": label, "summary": summary})
            return 1
        if os.environ.get("VRYX_CHAIN_BENCH_REQUIRE_FULL_TOKENS", "1").strip().lower() not in ("0", "false", "no", "off"):
            if int(summary.get("completion_tokens") or 0) < tokens:
                _emit({"ok": False, "error": "short_completion", "failed_label": label, "summary": summary})
                return 6
        if summary.get("duplicate_pending"):
            _emit({"ok": False, "error": "duplicate_pending", "failed_label": label, "summary": summary})
            return 7
        if summary.get("duplicate_microbatch"):
            _emit({"ok": False, "error": "duplicate_microbatch", "failed_label": label, "summary": summary})
            return 8
        if bool(item["expect_chain"]):
            if summary.get("chain_stream_used") is not True or summary.get("chain_result_direct") is not True:
                _emit({"ok": False, "error": "chain_not_used", "failed_label": label, "summary": summary})
                return 4
            if summary.get("fallback_used") or summary.get("request_response_fallback"):
                _emit({"ok": False, "error": "fallback_used", "failed_label": label, "summary": summary})
                return 5
        else:
            if summary.get("chain_stream_used") or summary.get("chain_result_direct"):
                _emit({"ok": False, "error": "stable_used_chain", "failed_label": label, "summary": summary})
                return 9

    direct_decode = [
        float(r.get("decode_tps") or 0.0)
        for r in results
        if r.get("mode") == "direct_chain_decode_only" and r.get("tokens_requested") in (24, 48, 128)
    ]
    summary = {
        "ok": True,
        "sequence": sequence,
        "caps": caps,
        "runs": len(results),
        "min_direct_decode_tps": round(min(direct_decode), 3) if direct_decode else 0.0,
        "m1_bottleneck_runs": [r.get("label") for r in results if r.get("m1_bottleneck")],
    }
    if direct_decode and min(direct_decode) < float(os.environ.get("VRYX_CHAIN_BENCH_MIN_DECODE_TPS", "3")):
        summary["ok"] = False
        summary["error"] = "decode_tps_below_target"
        _emit(summary)
        return 10
    _emit(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
