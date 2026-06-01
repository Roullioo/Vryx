#!/usr/bin/env python3
"""Bench Vryx decode-owner M1/M4.

Ce script envoie les flags par requete, sans override systemd global.
Il teste le mode experimental:
  VPS -> M4 full replica -> decode local microbatch cap32
avec fallback possible vers le chain coalesce stable.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


API_URL = os.environ.get("VRYX_API_URL", "https://vryx.eu").rstrip("/")
PROMPT = os.environ.get(
    "VRYX_BENCH_PROMPT",
    "Explique Vryx en une phrase technique, puis donne deux points d'optimisation.",
)
TOKENS = [
    int(x.strip())
    for x in os.environ.get("VRYX_BENCH_TOKENS", "24,48,128").split(",")
    if x.strip()
]
CAP = int(os.environ.get("VRYX_DECODE_MICROBATCH_CAP", "32"))
TIMEOUT_SEC = float(os.environ.get("VRYX_BENCH_HTTP_TIMEOUT_SEC", "1800"))


def post_chat(max_new_tokens: int) -> dict:
    payload = {
        "prompt": PROMPT,
        "max_new_tokens": max_new_tokens,
        "pool_preference": "velocity_mlx",
        "quantization": "fp16",
        "hidden_transport": "fp16",
        "chain_stream": True,
        "chain_result_direct": True,
        "chain_coalesced_decode": True,
        "decode_microbatch_cap": CAP,
        "decode_owner_final_peer": True,
        "decode_owner_fallback_chain": True,
        "bench_ignore_eos": True,
        "bench_force_tokens": True,
        "force_distributed": True,
    }
    req = urllib.request.Request(
        f"{API_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "http_status": exc.code,
            "error": body[:1000],
            "wall_ms": int((time.perf_counter() - started) * 1000),
        }
    return {
        **json.loads(body),
        "wall_ms": int((time.perf_counter() - started) * 1000),
    }


def summarize(label: str, result: dict) -> dict:
    trace = result.get("trace") if isinstance(result.get("trace"), dict) else {}
    perf = trace.get("perf_trace") if isinstance(trace.get("perf_trace"), dict) else {}
    decode_owner = trace.get("decode_owner") if isinstance(trace.get("decode_owner"), dict) else {}
    metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    return {
        "label": label,
        "ok": bool(result.get("ok")),
        "error": result.get("error"),
        "wall_ms": result.get("wall_ms"),
        "tokens": metrics.get("completion_tokens") or trace.get("tokens_generated"),
        "decode_tps": perf.get("decode_tps"),
        "global_tps": perf.get("global_tps") or trace.get("hot_path_tps"),
        "session_reused": trace.get("session_reused"),
        "layout": trace.get("layout"),
        "decode_owner": decode_owner,
        "coalesced_batches": perf.get("coalesced_batch_count"),
        "chain_hop_count": perf.get("chain_hop_count"),
        "batch_hop_count": perf.get("batch_hop_count"),
        "stream_reused": perf.get("stream_reused"),
        "request_response_fallback": perf.get("stream_fallback_count"),
        "m1_compute_ms": perf.get("m1_compute_ms"),
        "m4_compute_ms": perf.get("m4_compute_ms"),
        "chain_result_wait_ms": perf.get("chain_result_wait_ms"),
        "primary_bottleneck": perf.get("primary_bottleneck") or trace.get("primary_bottleneck"),
    }


def main() -> int:
    print(json.dumps({"api_url": API_URL, "tokens": TOKENS, "cap": CAP}, ensure_ascii=False))
    for token_count in TOKENS:
        label = f"direct{token_count}_decode_owner_cap{CAP}"
        result = post_chat(token_count)
        summary = summarize(label, result)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if not result.get("ok"):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
