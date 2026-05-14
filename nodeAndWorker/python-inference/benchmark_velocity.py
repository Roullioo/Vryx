"""Benchmark Velocity vs legacy PyTorch."""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor

import distributed_llm_orchestrator as orch


def _run(prompt: str, pool_preference: str) -> dict:
    t0 = time.perf_counter()
    result = orch.run_pipeline_chat(prompt, {"pool_preference": pool_preference, "quantization": "int8"})
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    trace = result.get("trace") or {}
    return {
        "ok": bool(result.get("ok")),
        "pool_preference": pool_preference,
        "elapsed_ms": elapsed_ms,
        "tps": trace.get("hot_path_tps", 0),
        "pool_class": trace.get("pool_class"),
        "runtime_backend_per_worker": trace.get("runtime_backend_per_worker"),
        "batching": trace.get("batching"),
    }


def main() -> None:
    prompt = "Réponds uniquement par OK."
    single_legacy = _run(prompt, "legacy_pytorch")
    single_velocity = _run(prompt, "velocity_mlx")
    prompts = [f"{prompt} Session {i}" for i in range(8)]
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=8) as pool:
        multi = list(pool.map(lambda p: _run(p, "auto"), prompts))
    print(json.dumps({
        "single_legacy": single_legacy,
        "single_velocity": single_velocity,
        "multi_auto": {
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "results": multi,
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
