#!/usr/bin/env python3
"""Benchmark et parite du scan Gated Delta MLX.

Exemples:
  VRYX_ENABLE_MLX_RUNTIME=1 VRYX_ENABLE_MLX_KERNELS=1 python benchmark_mlx_scan.py
  VRYX_MLX_SCAN_BACKEND=metal python benchmark_mlx_scan.py --backend metal
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import time
from contextlib import contextmanager
from typing import Any, Iterable

import numpy as np

from mlx_backend import MLXBackend

try:
    from mlx_scan_metal import metal_prototype_status
except Exception:
    metal_prototype_status = None


@contextmanager
def _patched_env(name: str, value: str):
    old = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old


def _backend_runner(requested_backend: str) -> MLXBackend:
    runner = object.__new__(MLXBackend)
    runner.scan_backend_requested = requested_backend
    runner.scan_backend_effective = requested_backend
    return runner


def _make_case(mx: Any, seq_len: int, seed: int, batch: int, heads: int, kdim: int, vdim: int) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    query = rng.normal(0.0, 0.25, size=(batch, seq_len, heads, kdim)).astype(np.float32)
    key = rng.normal(0.0, 0.25, size=(batch, seq_len, heads, kdim)).astype(np.float32)
    value = rng.normal(0.0, 0.25, size=(batch, seq_len, heads, vdim)).astype(np.float32)
    g = rng.normal(-1.0, 0.05, size=(batch, seq_len, heads)).astype(np.float32)
    beta = rng.uniform(0.05, 0.95, size=(batch, seq_len, heads)).astype(np.float32)
    return {
        "query": mx.array(query, dtype=mx.float32),
        "key": mx.array(key, dtype=mx.float32),
        "value": mx.array(value, dtype=mx.float32),
        "g": mx.array(g, dtype=mx.float32),
        "beta": mx.array(beta, dtype=mx.float32),
    }


def _run_once(mx: Any, backend: str, case: dict[str, Any]) -> tuple[Any, Any | None, str, float]:
    runner = _backend_runner(backend)
    with _patched_env("VRYX_MLX_SCAN_BACKEND", backend):
        started = time.perf_counter()
        out, state = runner._gated_delta_recurrent(
            mx,
            case["query"],
            case["key"],
            case["value"],
            case["g"],
            case["beta"],
            None,
            True,
        )
        mx.eval(out, state)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
    return out, state, runner.scan_backend_effective, elapsed_ms


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((pct / 100.0) * (len(ordered) - 1))))
    return ordered[idx]


def _compare(mx: Any, backend: str, seq_len: int, runs: int, args: argparse.Namespace) -> dict[str, Any]:
    case = _make_case(mx, seq_len, args.seed + seq_len, args.batch, args.heads, args.kdim, args.vdim)
    ref_out, ref_state, ref_effective, ref_ms = _run_once(mx, "python", case)
    ref_out_np = np.array(ref_out, copy=True)
    ref_state_np = np.array(ref_state, copy=True)

    # Warmup compilation/lazy graph before timed runs.
    _run_once(mx, backend, case)

    elapsed: list[float] = []
    effective_backends: set[str] = set()
    max_abs_out = 0.0
    max_abs_state = 0.0
    for _ in range(runs):
        out, state, effective, elapsed_ms = _run_once(mx, backend, case)
        effective_backends.add(effective)
        out_np = np.array(out, copy=True)
        state_np = np.array(state, copy=True)
        max_abs_out = max(max_abs_out, float(np.max(np.abs(out_np - ref_out_np))))
        max_abs_state = max(max_abs_state, float(np.max(np.abs(state_np - ref_state_np))))
        elapsed.append(elapsed_ms)

    parity_ok = max(max_abs_out, max_abs_state) <= args.atol
    return {
        "backend_requested": backend,
        "backend_effective": sorted(effective_backends),
        "seq_len": seq_len,
        "runs": runs,
        "parity_ok": parity_ok,
        "max_abs_out": max_abs_out,
        "max_abs_state": max_abs_state,
        "atol": args.atol,
        "reference_backend": ref_effective,
        "reference_first_ms": round(ref_ms, 3),
        "avg_ms": round(statistics.fmean(elapsed), 3),
        "p50_ms": round(statistics.median(elapsed), 3),
        "p95_ms": round(_percentile(elapsed, 95), 3),
        "tokens_per_s": round((seq_len * args.batch * runs * 1000.0) / max(sum(elapsed), 1e-9), 3),
    }


def _parse_seq_lens(raw: str) -> list[int]:
    return [int(item.strip()) for item in raw.split(",") if item.strip()]


def _backends(raw: str) -> Iterable[str]:
    if raw == "all":
        return ("python", "chunked", "metal")
    return (raw,)


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark/parite du scan Gated Delta MLX")
    parser.add_argument("--backend", choices=("all", "python", "chunked", "metal"), default="all")
    parser.add_argument("--seq-lens", default="1,16,64")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--kdim", type=int, default=64)
    parser.add_argument("--vdim", type=int, default=64)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--atol", type=float, default=1e-5)
    args = parser.parse_args()

    try:
        import mlx.core as mx
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"mlx_unavailable:{exc}"}, ensure_ascii=False, indent=2))
        return 2

    results = []
    for backend in _backends(args.backend):
        for seq_len in _parse_seq_lens(args.seq_lens):
            results.append(_compare(mx, backend, seq_len, max(1, args.runs), args))

    report = {
        "ok": all(item["parity_ok"] for item in results),
        "scan_backend_env": "VRYX_MLX_SCAN_BACKEND",
        "strict_metal_env": "VRYX_MLX_SCAN_STRICT",
        "shape": {
            "batch": args.batch,
            "heads": args.heads,
            "kdim": args.kdim,
            "vdim": args.vdim,
        },
        "metal_prototype": metal_prototype_status() if metal_prototype_status else None,
        "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
