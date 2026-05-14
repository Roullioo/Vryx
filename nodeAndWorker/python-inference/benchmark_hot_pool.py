#!/usr/bin/env python3
"""Benchmark du chemin chaud Vryx P2P sans calcul LLM côté VPS."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

import distributed_llm_orchestrator as orchestrator


VARIANTS = {
    "baseline": {"VRYX_HIDDEN_QUIC": "0", "VRYX_PREFIX_CACHE": "0"},
    "quic": {"VRYX_HIDDEN_QUIC": "1", "VRYX_PREFIX_CACHE": "0"},
    "cache-miss": {"VRYX_HIDDEN_QUIC": "0", "VRYX_PREFIX_CACHE": "1"},
    "cache-hit": {"VRYX_HIDDEN_QUIC": "0", "VRYX_PREFIX_CACHE": "1"},
    "quic-cache": {"VRYX_HIDDEN_QUIC": "1", "VRYX_PREFIX_CACHE": "1"},
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark hot pool P2P Vryx")
    parser.add_argument("--prompt", default="Réponds en une phrase : qui es-tu ?")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="")
    parser.add_argument("--all-variants", action="store_true")
    parser.add_argument("--single", action="store_true")
    args = parser.parse_args()

    if args.all_variants and not args.single:
        reports = []
        for name, env_patch in VARIANTS.items():
            env = {**os.environ, **env_patch}
            cmd = [
                sys.executable,
                __file__,
                "--single",
                "--variant",
                name,
                "--prompt",
                args.prompt,
                "--runs",
                str(args.runs),
            ]
            completed = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=None)
            try:
                report = json.loads(completed.stdout)
            except Exception:
                report = {"ok": False, "variant": name, "stdout": completed.stdout, "stderr": completed.stderr}
            report["exit_code"] = completed.returncode
            reports.append(report)
        ok_reports = [r for r in reports if r.get("ok")]
        comparison = {
            "ok": bool(ok_reports),
            "variants": reports,
            "summary": [
                {
                    "variant": r.get("variant"),
                    "avg_tps": r.get("avg_tps"),
                    "avg_ttft_ms": r.get("avg_ttft_ms"),
                    "quic_used": r.get("feature_flags", {}).get("hidden_quic"),
                    "prefix_cache": r.get("feature_flags", {}).get("prefix_cache"),
                }
                for r in reports
            ],
        }
        print(json.dumps(comparison, ensure_ascii=False, indent=2))
        return 0 if comparison["ok"] else 1

    results = []
    for run in range(max(1, args.runs)):
        started = time.perf_counter()
        result = orchestrator.run_pipeline_chat(args.prompt)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        trace = result.get("trace") or {}
        metrics = result.get("metrics") or {}
        benchmark = trace.get("benchmark") or {}
        prefix_cache = trace.get("prefix_cache") or {}
        completion_tokens = int(metrics.get("completion_tokens") or trace.get("tokens_generated") or 0)
        tps = round((completion_tokens * 1000.0 / elapsed_ms), 3) if elapsed_ms > 0 else 0
        results.append({
            "run": run + 1,
            "ok": bool(result.get("ok")),
            "elapsed_ms": elapsed_ms,
            "ttft_ms": (trace.get("steps") or [{}])[0].get("latency_ms") if trace.get("steps") else None,
            "completion_tokens": completion_tokens,
            "tps": tps,
            "avg_ms_per_token": trace.get("avg_ms_per_token"),
            "routing_path": trace.get("routing_path"),
            "hidden_transport": trace.get("hidden_transport"),
            "worker_kv_cache": trace.get("worker_kv_cache"),
            "stream_session_hot": (trace.get("stream_open") or {}).get("ok"),
            "quic_enabled": trace.get("quic_enabled"),
            "quic_used": trace.get("quic_used"),
            "quic_fallback_reason": trace.get("quic_fallback_reason"),
            "prefix_cache_hit": prefix_cache.get("hit"),
            "prefix_cache_tokens": prefix_cache.get("tokens"),
            "prefix_cache_metadata_only": prefix_cache.get("metadata_only"),
            "benchmark": benchmark,
            "peer_latency_matrix": trace.get("peer_latency_matrix"),
            "error": result.get("error") or trace.get("warning"),
        })

    ok_runs = [r for r in results if r["ok"]]
    avg_tps = round(sum(r["tps"] for r in ok_runs) / len(ok_runs), 3) if ok_runs else 0
    ttfts = [int(r["ttft_ms"]) for r in ok_runs if r.get("ttft_ms") is not None]
    report = {
        "ok": bool(ok_runs),
        "variant": args.variant or "current-env",
        "model_id": orchestrator.MODEL_ID,
        "runs": results,
        "avg_tps": avg_tps,
        "avg_ttft_ms": int(sum(ttfts) / len(ttfts)) if ttfts else None,
        "target_tps": 15,
        "target_ms_per_token": 66,
        "feature_flags": {
            "hidden_quic": orchestrator.HIDDEN_QUIC,
            "prefix_cache": orchestrator.PREFIX_CACHE,
            "speculative_heads": orchestrator.SPECULATIVE_HEADS,
            "continuous_batching": orchestrator.CONTINUOUS_BATCHING,
            "chunked_prefill": orchestrator.CHUNKED_PREFILL,
            "ring_attention": orchestrator.RING_ATTENTION,
        },
        "acceptance": {
            "minimum_workers": 3,
            "vps_delegate_ms": 0,
            "hidden_transport": orchestrator.HIDDEN_TRANSPORT,
            "stream_mode": orchestrator.PIPELINE_STREAM_MODE,
            "worker_kv_cache": orchestrator.WORKER_KV_CACHE,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
