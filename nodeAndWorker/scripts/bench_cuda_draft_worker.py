#!/usr/bin/env python3
"""Benchmark a CUDA draft worker without touching the GGUF shard hot path."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PY_INFERENCE = ROOT / "python-inference"
sys.path.insert(0, str(PY_INFERENCE))

import shard_runtime  # noqa: E402


def _json_call(model: str, prompt: str, max_new_tokens: int) -> dict:
    payload = {
        "model_id": model,
        "prompt": prompt,
        "max_new_tokens": max_new_tokens,
        "temperature": 0,
    }
    raw = shard_runtime.cuda_direct_generate(json.dumps(payload).encode("utf-8"))
    return json.loads(raw.decode("utf-8", errors="replace"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("VRYX_CUDA_DRAFT_MODEL") or os.environ.get("VRYX_WORKER_MODEL") or "Qwen/Qwen2.5-1.5B-Instruct")
    parser.add_argument("--prompt", default="Reponds en une phrase: quel est le role d'un draft worker?")
    parser.add_argument("--max-new-tokens", type=int, default=32)
    parser.add_argument("--repeats", type=int, default=2)
    args = parser.parse_args()

    os.environ.setdefault("VRYX_CUDA_DIRECT", "1")
    results = []
    started = time.perf_counter()
    for i in range(max(1, args.repeats)):
        res = _json_call(args.model, args.prompt, args.max_new_tokens)
        res["iteration"] = i + 1
        print(json.dumps(res, ensure_ascii=True), flush=True)
        if not res.get("ok"):
            return 2
        results.append(res)

    hot = [float(r.get("actual_tps") or 0) for r in results if r.get("cache_hit")]
    all_tps = [float(r.get("actual_tps") or 0) for r in results]
    summary = {
        "ok": True,
        "model_id": args.model,
        "repeats": len(results),
        "wall_ms": int((time.perf_counter() - started) * 1000),
        "hot_tps_median": round(statistics.median(hot), 3) if hot else None,
        "tps_median": round(statistics.median(all_tps), 3) if all_tps else None,
        "last_vram_allocated_mb": results[-1].get("cuda_allocated_mb") if results else None,
        "last_vram_reserved_mb": results[-1].get("cuda_reserved_mb") if results else None,
        "draft_acceptance_rate": None,
    }
    print(json.dumps({"summary": summary}, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
