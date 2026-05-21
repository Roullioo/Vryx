#!/usr/bin/env python3
"""Benchmark reproductible du chat P2P initiateur VPS.

Par defaut, le script cible l'initiateur local du VPS :

  ./nodeAndWorker/scripts/bench_vps_chat_tps.py

Variables utiles :

  VRYX_BENCH_URL=http://127.0.0.1:3031/api/chat
  VRYX_BENCH_TOKENS=64,128,256
  VRYX_BENCH_TARGET_TPS=50
  VRYX_BENCH_POOL=auto
  VRYX_BENCH_QUANT=fp16
  VRYX_BENCH_MODEL=Qwen/Qwen3.5-9B
  VRYX_BENCH_LOAD_MODE=full
  VRYX_BENCH_FORCE_DISTRIBUTED=0
  VRYX_BENCH_MIN_COMPUTE_WORKERS=0
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def _env_list(name: str, default: str) -> list[int]:
    raw = os.environ.get(name, default)
    values: list[int] = []
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            raise SystemExit(f"{name} contient une valeur non entiere: {part!r}")
        if value <= 0:
            raise SystemExit(f"{name} doit contenir des valeurs > 0")
        values.append(value)
    return values or [128]


def _chat(url: str, max_new_tokens: int, prompt: str, timeout_sec: float) -> dict[str, Any]:
    payload = {
        "prompt": prompt,
        "max_new_tokens": max_new_tokens,
        "quantization": os.environ.get("VRYX_BENCH_QUANT", "fp16"),
        "pool_preference": os.environ.get("VRYX_BENCH_POOL", "auto"),
    }
    model = os.environ.get("VRYX_BENCH_MODEL", "").strip()
    if model:
        payload["model_id"] = model
    load_mode = os.environ.get("VRYX_BENCH_LOAD_MODE", "").strip()
    if load_mode:
        payload["load_mode"] = load_mode
    if os.environ.get("VRYX_BENCH_FORCE_DISTRIBUTED", "").strip().lower() in ("1", "true", "yes", "on"):
        payload["force_distributed"] = True
    preferred = os.environ.get("VRYX_BENCH_PREFERRED_WORKERS", "").strip()
    if preferred:
        payload["preferred_worker_peer_ids"] = [
            peer.strip()
            for peer in preferred.replace(";", ",").split(",")
            if peer.strip()
        ]
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    wall_ms = int((time.perf_counter() - started) * 1000)
    data = json.loads(raw)
    data["_client_wall_ms"] = wall_ms
    return data


def _metric(data: dict[str, Any], tokens_requested: int) -> dict[str, Any]:
    trace = data.get("pipeline_trace") if isinstance(data.get("pipeline_trace"), dict) else {}
    bench = trace.get("benchmark") if isinstance(trace.get("benchmark"), dict) else {}
    ct = int(data.get("completion_tokens") or 0)
    response = data.get("response")
    response_chars = len(response) if isinstance(response, str) else 0
    wall_ms = int(data.get("_client_wall_ms") or data.get("latency_ms") or 0)
    latency_ms = int(data.get("latency_ms") or wall_ms)
    tps_wall = round((ct * 1000.0 / wall_ms), 3) if wall_ms > 0 and ct > 0 else 0.0
    tps_latency = round((ct * 1000.0 / latency_ms), 3) if latency_ms > 0 and ct > 0 else 0.0
    runtime_by_worker = trace.get("runtime_backend_per_worker")
    runtime_backend = data.get("runtime_backend") or bench.get("runtime_backend")
    if not runtime_backend and isinstance(runtime_by_worker, dict) and runtime_by_worker:
        runtime_backend = next(iter(runtime_by_worker.values()))
    return {
        "ok": bool(data.get("ok")) and (ct > 0 or response_chars > 0),
        "empty_response": ct <= 0 and response_chars <= 0,
        "tokens_requested": tokens_requested,
        "completion_tokens": ct,
        "response_chars": response_chars,
        "client_wall_ms": wall_ms,
        "server_latency_ms": latency_ms,
        "tps_wall": tps_wall,
        "tps_latency": tps_latency,
        "decode_tps": bench.get("decode_only_tps") or bench.get("actual_tps"),
        "decode_only_tps": bench.get("decode_only_tps") or bench.get("actual_tps"),
        "e2e_tps": bench.get("e2e_tps") or tps_wall,
        "trace_actual_tps": bench.get("actual_tps"),
        "trace_ms_per_token": bench.get("actual_ms_per_token"),
        "decode_only_ms": bench.get("decode_only_ms"),
        "decode_only_tokens": bench.get("decode_only_tokens"),
        "decode_only_avg_ms_per_token": bench.get("decode_only_avg_ms_per_token"),
        "prefill_ms": bench.get("prefill_ms"),
        "setup_ms": bench.get("setup_ms"),
        "ttft_ms": bench.get("ttft_ms"),
        "relay_ms": bench.get("relay_ms"),
        "eval_ms": bench.get("eval_ms"),
        "prompt_eval_ms": bench.get("prompt_eval_ms"),
        "cache_hit": bench.get("cache_hit"),
        "load_ms": bench.get("load_ms"),
        "layout": trace.get("layout"),
        "runtime_backend": runtime_backend,
        "model_id": trace.get("model_id") or data.get("model_id"),
        "worker_count": trace.get("worker_count") or trace.get("peers_online"),
        "compute_worker_count": trace.get("compute_worker_count") or trace.get("worker_count"),
        "visible_worker_count": trace.get("visible_worker_count") or trace.get("peers_online"),
        "available_peers": trace.get("available_peers"),
    }


def main() -> int:
    url = os.environ.get("VRYX_BENCH_URL", "http://127.0.0.1:3031/api/chat").strip()
    if not url.endswith("/api/chat"):
        url = url.rstrip("/") + "/api/chat"
    timeout_sec = float(os.environ.get("VRYX_BENCH_HTTP_TIMEOUT", "360"))
    target_tps = float(os.environ.get("VRYX_BENCH_TARGET_TPS", "50"))
    min_compute_workers = int(os.environ.get("VRYX_BENCH_MIN_COMPUTE_WORKERS", "0") or "0")
    token_counts = _env_list("VRYX_BENCH_TOKENS", "64,128,256")
    prompt = os.environ.get(
        "VRYX_BENCH_PROMPT",
        "Continue the sequence with comma-separated numbers only: 1, 2, 3, 4, 5,",
    )

    results: list[dict[str, Any]] = []
    for tokens in token_counts:
        try:
            data = _chat(url, tokens, prompt, timeout_sec)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:1000]
            print(json.dumps({"ok": False, "http_status": exc.code, "body": body}, ensure_ascii=False), file=sys.stderr)
            return 1
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
            return 1
        metric = _metric(data, tokens)
        results.append(metric)
        print(json.dumps(metric, ensure_ascii=False, sort_keys=True), flush=True)

    decode_values = [float(r["decode_only_tps"] or r["decode_tps"] or r["trace_actual_tps"] or 0.0) for r in results if r.get("ok")]
    e2e_values = [float(r["tps_wall"] or 0.0) for r in results if r.get("ok")]
    sustained = decode_values or e2e_values
    best = max(sustained) if sustained else 0.0
    median = statistics.median(sustained) if sustained else 0.0
    summary = {
        "ok": bool(results) and all(r.get("ok") for r in results),
        "target_tps": target_tps,
        "min_compute_workers": min_compute_workers,
        "best_decode_tps": round(max(decode_values), 3) if decode_values else 0.0,
        "median_decode_tps": round(float(statistics.median(decode_values)), 3) if decode_values else 0.0,
        "best_e2e_tps": round(max(e2e_values), 3) if e2e_values else 0.0,
        "median_e2e_tps": round(float(statistics.median(e2e_values)), 3) if e2e_values else 0.0,
        "best_tps": round(best, 3),
        "median_tps": round(float(median), 3),
        "target_reached": best >= target_tps,
        "empty_responses": sum(1 for r in results if r.get("empty_response")),
        "runs": len(results),
    }
    if min_compute_workers > 0:
        worker_counts = [int(r.get("compute_worker_count") or 0) for r in results if r.get("ok")]
        summary["min_compute_workers_reached"] = bool(worker_counts) and min(worker_counts) >= min_compute_workers
        summary["ok"] = bool(summary["ok"]) and bool(summary["min_compute_workers_reached"])
    else:
        summary["min_compute_workers_reached"] = None
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if summary["target_reached"] and summary["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
