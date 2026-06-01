#!/usr/bin/env python3
"""Quality smoke for Qwen shard-only vs full-local decode-owner.

The goal is not TPS. It is to make incoherent generation debuggable by forcing
deterministic decoding and collecting token/logit/hidden/KV/position checksums.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


DEFAULT_API = os.environ.get("VRYX_API_URL", "http://127.0.0.1:3031").rstrip("/")
DEFAULT_MODEL = os.environ.get("VRYX_QUALITY_MODEL", "Qwen/Qwen3.6-35B-A3B")
DEFAULT_PROMPT = os.environ.get(
    "VRYX_QUALITY_PROMPT",
    "Explique en une phrase simple pourquoi le ciel est bleu.",
)
DEFAULT_M1 = os.environ.get("VRYX_M1_PEER", "12D3KooWESn1beAZLi7nbARKqvD5oSdSArQFQow3581nXhrYbuEM")
DEFAULT_M4 = os.environ.get("VRYX_M4_PEER", "12D3KooWJGeDM978MnTrHkLACeFPx5rtgbfXtrEarnzLZBHeuyPU")


def post_json(url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=raw,
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            parsed = json.loads(body.decode("utf-8", errors="replace"))
            parsed.setdefault("_http_status", resp.status)
            parsed.setdefault("_wall_ms", int((time.perf_counter() - started) * 1000))
            return parsed
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "_http_status": exc.code,
            "_wall_ms": int((time.perf_counter() - started) * 1000),
            "error": body[:2000],
        }
    except Exception as exc:
        return {
            "ok": False,
            "_http_status": None,
            "_wall_ms": int((time.perf_counter() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
        }


def get_json(url: str, timeout: int = 15) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def trace_summary(result: dict[str, Any]) -> dict[str, Any]:
    pipeline_trace = result.get("pipeline_trace") if isinstance(result.get("pipeline_trace"), dict) else {}
    phase = result.get("phase_trace") if isinstance(result.get("phase_trace"), dict) else {}
    if not phase and isinstance(pipeline_trace.get("phase_trace"), dict):
        phase = pipeline_trace["phase_trace"]
    tokens = phase.get("tokens") if isinstance(phase.get("tokens"), list) else []
    hop_traces: list[dict[str, Any]] = []
    for tok in tokens[:4]:
        if isinstance(tok, dict):
            for hop in tok.get("hop_traces") or []:
                if isinstance(hop, dict):
                    hop_traces.append(hop)
    quality = []
    for hop in hop_traces:
        tr = hop.get("transport_trace")
        if not isinstance(tr, dict):
            tr = {}
        quality_trace = tr.get("quality_trace")
        if not isinstance(quality_trace, dict) and isinstance(hop.get("worker_transport_trace"), dict):
            quality_trace = hop["worker_transport_trace"].get("quality_trace")
        if isinstance(tr, dict) and isinstance(quality_trace, dict):
            quality.append({
                "peer": hop.get("peer") or hop.get("worker_peer_id"),
                "step": quality_trace.get("step"),
                "decode_mode": quality_trace.get("decode_mode"),
                "token_ids": quality_trace.get("token_ids"),
                "generated_token_ids": quality_trace.get("generated_token_ids"),
                "hidden_input_checksum": quality_trace.get("hidden_input_checksum"),
                "hidden_output_checksum": quality_trace.get("hidden_output_checksum"),
                "hidden_received_checksum": quality_trace.get("hidden_received_checksum"),
                "position_ids_start": quality_trace.get("position_ids_start"),
                "position_ids_end": quality_trace.get("position_ids_end"),
                "cache_position_start": quality_trace.get("cache_position_start"),
                "cache_position_end": quality_trace.get("cache_position_end"),
                "kv_cache_step_start": quality_trace.get("kv_cache_step_start"),
                "kv_cache_step_end": quality_trace.get("kv_cache_step_end"),
                "lm_head_input_checksum": quality_trace.get("lm_head_input_checksum"),
                "logits_checksum": quality_trace.get("logits_checksum"),
                "next_token_id": quality_trace.get("next_token_id"),
                "nan_counts": {
                    k: v
                    for k, v in quality_trace.items()
                    if k.endswith("_nan_count") and isinstance(v, int)
                },
            })
    return {
        "ok": result.get("ok", result.get("error") is None),
        "http_status": result.get("_http_status"),
        "wall_ms": result.get("_wall_ms") or result.get("latency_ms"),
        "text": result.get("response") or result.get("text") or result.get("output") or "",
        "metrics": result.get("metrics"),
        "decode_tps": result.get("decode_tps") or phase.get("decode_tps") or pipeline_trace.get("hot_path_tps"),
        "global_tps": result.get("global_tps") or phase.get("global_tps"),
        "session_reused": phase.get("session_reused") or result.get("session_reused") or pipeline_trace.get("session_reused"),
        "routing_path": result.get("routing_path") or phase.get("routing_path") or pipeline_trace.get("routing_path"),
        "generated_token_ids": result.get("generated_token_ids") or phase.get("generated_token_ids") or pipeline_trace.get("tokens_generated"),
        "quality_hops": quality,
        "error": result.get("error"),
    }


def make_payload(
    *,
    prompt: str,
    model: str,
    max_new_tokens: int,
    preferred: list[str],
    full_local_decode_owner: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "model_id": model,
        "prompt": prompt,
        "max_new_tokens": max_new_tokens,
        "temperature": 0,
        "weight_quantization": "q4",
        "hidden_transport": "fp16",
        "quality_trace": True,
        "debug_top_logits": True,
        "preferred_worker_peer_ids": preferred,
        "force_distributed": not full_local_decode_owner,
        "chain_stream": True,
        "chain_result_direct": True,
        "chain_coalesced_decode": False,
        "decode_microbatch_cap": 1,
        "bench_ignore_eos": False,
        "bench_force_tokens": False,
    }
    if full_local_decode_owner:
        payload["decode_owner_final_peer"] = True
        payload["decode_owner_fallback_chain"] = False
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--max-new-tokens", type=int, default=int(os.environ.get("VRYX_QUALITY_MAX_NEW_TOKENS", "16")))
    parser.add_argument("--m1", default=DEFAULT_M1)
    parser.add_argument("--m4", default=DEFAULT_M4)
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("VRYX_QUALITY_HTTP_TIMEOUT", "900")))
    parser.add_argument("--output", default=os.environ.get("VRYX_QUALITY_OUTPUT", "/tmp/vryx-qwen-quality-compare.json"))
    args = parser.parse_args()

    peers = get_json(f"{args.api}/api/tp-peers")
    peer_ids: set[str] = set()
    if isinstance(peers.get("peers"), list):
        for item in peers.get("peers", []):
            if isinstance(item, dict):
                peer_id = item.get("peer_id") or item.get("peerId") or item.get("id")
            else:
                peer_id = item
            if peer_id:
                peer_ids.add(str(peer_id))

    runs: dict[str, Any] = {
        "config": {
            "api": args.api,
            "model": args.model,
            "prompt": args.prompt,
            "max_new_tokens": args.max_new_tokens,
            "m1": args.m1,
            "m4": args.m4,
            "peer_count": peers.get("count"),
            "peer_ids": sorted(peer_ids),
        },
        "full_m4": None,
        "split_m1_m4": None,
    }

    print("[quality] full local M4 decode-owner...")
    full_payload = make_payload(
        prompt=args.prompt,
        model=args.model,
        max_new_tokens=args.max_new_tokens,
        preferred=[args.m4],
        full_local_decode_owner=True,
    )
    full_result = post_json(f"{args.api}/api/chat", full_payload, args.timeout)
    runs["full_m4"] = {
        "payload": full_payload,
        "summary": trace_summary(full_result),
        "raw": full_result,
    }

    if args.m1 in peer_ids and args.m4 in peer_ids:
        print("[quality] shard split M1/M4 0-1 / 2-39...")
        split_payload = make_payload(
            prompt=args.prompt,
            model=args.model,
            max_new_tokens=args.max_new_tokens,
            preferred=[args.m1, args.m4],
            full_local_decode_owner=False,
        )
        split_result = post_json(f"{args.api}/api/chat", split_payload, args.timeout)
        runs["split_m1_m4"] = {
            "payload": split_payload,
            "summary": trace_summary(split_result),
            "raw": split_result,
        }
    else:
        runs["split_m1_m4"] = {
            "skipped": True,
            "reason": "m1_or_m4_peer_absent",
            "m1_present": args.m1 in peer_ids,
            "m4_present": args.m4 in peer_ids,
        }
        print("[quality] split skipped: M1 ou M4 absent de /api/tp-peers")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(runs, f, ensure_ascii=False, indent=2)

    for name in ("full_m4", "split_m1_m4"):
        item = runs.get(name) or {}
        summary = item.get("summary") if isinstance(item, dict) else None
        if summary:
            print(
                f"[quality] {name}: ok={summary.get('ok')} wall_ms={summary.get('wall_ms')} "
                f"session_reused={summary.get('session_reused')} text={summary.get('text')[:120]!r}"
            )
        else:
            print(f"[quality] {name}: {item}")
    print(f"[quality] wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
