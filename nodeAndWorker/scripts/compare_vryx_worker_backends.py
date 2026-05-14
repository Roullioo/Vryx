#!/usr/bin/env python3
"""Compare le backend worker VRYX PyTorch vs MLX sur un prompt court.

Ce test bypass le réseau P2P : il charge un modèle HF, extrait une tranche complète
comme l'orchestrateur, puis exécute `shard_runtime` avec les deux backends.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PYDIR = ROOT / "python-inference"
import sys

sys.path.insert(0, str(PYDIR))


def run_backend(model: Any, tokenizer: Any, cfg: dict[str, Any], prompt: str, backend: str) -> dict[str, Any]:
    import distributed_llm_orchestrator as orch
    import shard_runtime

    sid = f"cmp-{backend}-{int(time.time() * 1000)}"
    total_layers = int(cfg["num_hidden_layers_total"])
    weights = orch._extract_worker_weights(model, 0, total_layers - 1, True, True)  # noqa: SLF001

    meta = {
        "session_id": sid,
        "layer_start": 0,
        "layer_end": total_layers - 1,
        "model_config": cfg,
        "has_embedding": True,
        "has_lm_head": True,
        "ttl_sec": 600,
        "runtime_backend": backend,
        "supports_mlx": backend == "mlx",
        "model_id": os.environ.get("VRYX_COMPARE_MODEL", ""),
    }
    os.environ["VRYX_DEBUG_TOP_LOGITS"] = "1"
    if backend == "mlx":
        os.environ["VRYX_ENABLE_MLX_RUNTIME"] = "1"
        os.environ["VRYX_ENABLE_MLX_KERNELS"] = "1"
        os.environ["VRYX_RUNTIME_BACKEND"] = "mlx"
        os.environ["VRYX_MLX_STRICT"] = "1"
        os.environ["VRYX_DISABLE_PYTORCH_FALLBACK"] = "1"
        os.environ.setdefault("VRYX_MLX_MAX_SHARD_GB", "24")
    else:
        os.environ["VRYX_RUNTIME_BACKEND"] = "pytorch"
        os.environ.pop("VRYX_MLX_STRICT", None)
        os.environ.pop("VRYX_DISABLE_PYTORCH_FALLBACK", None)

    init = json.loads(shard_runtime.pipeline_shard_init(json.dumps(meta).encode()))
    shard = shard_runtime._shards[sid]  # noqa: SLF001
    shard.weight_arrays.update({k: np.asarray(v) for k, v in weights.items()})
    shard.weights_loaded = len(shard.weight_arrays)
    t0 = time.perf_counter()
    build = json.loads(shard_runtime.pipeline_shard_build(sid))
    build_ms = int((time.perf_counter() - t0) * 1000)
    if not build.get("ok"):
        return {"backend": backend, "ok": False, "init": init, "build": build, "build_ms": build_ms}

    ids = tokenizer.encode(prompt)
    payload = {
        "session_id": sid,
        "request_id": f"cmp-{backend}",
        "token_ids": ids,
        "history_token_ids": ids,
        "step": 0,
        "seq_pos": 0,
        "decode_mode": "prefill_full_context",
        "use_kv_cache": False,
        "sampling": {"temperature": 0.0, "top_p": 0.75, "top_k": 20, "repetition_penalty": 1.0},
        "hidden_transport": "fp16",
    }
    t1 = time.perf_counter()
    raw = shard_runtime.pipeline_shard_forward(json.dumps(payload).encode(), sid)
    forward_ms = int((time.perf_counter() - t1) * 1000)
    out = json.loads(raw.decode("utf-8", errors="replace"))
    token_id = out.get("next_token_id")
    text = tokenizer.decode([int(token_id)], skip_special_tokens=False) if token_id is not None else ""
    return {
        "backend": backend,
        "ok": out.get("ok") is not False,
        "init": init,
        "build": build,
        "build_ms": build_ms,
        "forward_ms": forward_ms,
        "next_token_id": token_id,
        "next_token_text": text,
        "debug_top_logits": out.get("debug_top_logits") or [],
        "error": out.get("error"),
    }


def main() -> int:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch
    import distributed_llm_orchestrator as orch

    model_id = os.environ.get("VRYX_COMPARE_MODEL", "Qwen/Qwen2-0.5B-Instruct")
    prompt = os.environ.get(
        "VRYX_COMPARE_PROMPT",
        "<|im_start|>user\nWhat is 1+1? Answer only 2.\n<|im_end|>\n<|im_start|>assistant\n",
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        trust_remote_code=True,
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
    )
    model.eval()
    cfg = orch._build_model_config(model.config)  # noqa: SLF001
    result = {"model": model_id, "prompt": prompt, "config": cfg, "results": []}
    for backend in os.environ.get("VRYX_COMPARE_BACKENDS", "pytorch,mlx").split(","):
        backend = backend.strip()
        if backend:
            result["results"].append(run_backend(model, tokenizer, cfg, prompt, backend))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
