#!/usr/bin/env python3
"""Compare un prompt court entre Transformers/PyTorch et mlx-lm.

Usage:
  cd nodeAndWorker
  VRYX_COMPARE_MODEL=Qwen/Qwen3.5-9B ./scripts/compare_qwen_logits.py

Le script est volontairement hors du chemin P2P : il sert de référence qualité/logits
avant de valider le backend worker visible dans le chat.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any


def topk(values: Any, k: int = 10) -> list[dict[str, float | int]]:
    import numpy as np

    arr = np.asarray(values, dtype="float32").reshape(-1)
    idx = np.argpartition(-arr, min(k, arr.size - 1))[:k]
    idx = idx[np.argsort(-arr[idx])]
    return [{"id": int(i), "logit": float(arr[i])} for i in idx]


def run_transformers(model_id: str, prompt: str, max_new_tokens: int) -> dict[str, Any]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        trust_remote_code=True,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    ).to(device)
    model.eval()
    load_ms = int((time.perf_counter() - t0) * 1000)

    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    t1 = time.perf_counter()
    with torch.no_grad():
        out = model(**inputs)
        logits = out.logits[0, -1].detach().float().cpu().numpy()
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    infer_ms = int((time.perf_counter() - t1) * 1000)
    new_ids = generated[0, inputs["input_ids"].shape[-1] :].detach().cpu().tolist()
    text = tokenizer.decode(new_ids, skip_special_tokens=True)
    return {
        "ok": True,
        "backend": "transformers",
        "device": device,
        "load_ms": load_ms,
        "infer_ms": infer_ms,
        "new_token_ids": [int(x) for x in new_ids],
        "text": text,
        "top_logits": topk(logits),
    }


def run_mlx_lm(model_id: str, prompt: str, max_new_tokens: int) -> dict[str, Any]:
    import mlx.core as mx
    from mlx_lm import generate, load

    t0 = time.perf_counter()
    model, tokenizer = load(model_id)
    load_ms = int((time.perf_counter() - t0) * 1000)

    input_ids = tokenizer.encode(prompt)
    t1 = time.perf_counter()
    logits = model(mx.array([input_ids]))
    if isinstance(logits, tuple):
        logits = logits[0]
    mx.eval(logits)
    last = logits[0, -1]
    text = generate(model, tokenizer, prompt=prompt, max_tokens=max_new_tokens, verbose=False)
    infer_ms = int((time.perf_counter() - t1) * 1000)
    return {
        "ok": True,
        "backend": "mlx_lm",
        "load_ms": load_ms,
        "infer_ms": infer_ms,
        "text": text[len(prompt) :] if text.startswith(prompt) else text,
        "top_logits": topk(mx.array(last).tolist()),
    }


def main() -> int:
    model_id = os.environ.get("VRYX_COMPARE_MODEL", "Qwen/Qwen3.5-9B")
    prompt = os.environ.get(
        "VRYX_COMPARE_PROMPT",
        "<|im_start|>user\nWhat is 1+1? Answer only 2.\n<|im_end|>\n<|im_start|>assistant\n",
    )
    max_new_tokens = int(os.environ.get("VRYX_COMPARE_MAX_NEW_TOKENS", "8"))

    result: dict[str, Any] = {"model": model_id, "prompt": prompt, "max_new_tokens": max_new_tokens}
    errors: list[dict[str, str]] = []
    for name, fn in (("transformers", run_transformers), ("mlx_lm", run_mlx_lm)):
        try:
            result[name] = fn(model_id, prompt, max_new_tokens)
        except Exception as exc:
            errors.append({"backend": name, "error": f"{type(exc).__name__}: {exc}"})
    result["errors"] = errors

    a = result.get("transformers", {}).get("top_logits") if isinstance(result.get("transformers"), dict) else None
    b = result.get("mlx_lm", {}).get("top_logits") if isinstance(result.get("mlx_lm"), dict) else None
    if a and b:
        result["compare"] = {
            "top1_match": int(a[0]["id"]) == int(b[0]["id"]),
            "transformers_top1": a[0],
            "mlx_lm_top1": b[0],
            "top10_overlap": len({int(x["id"]) for x in a} & {int(x["id"]) for x in b}),
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
