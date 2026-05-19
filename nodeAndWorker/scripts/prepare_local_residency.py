#!/usr/bin/env python3
"""Prepare the local worker residency after the P2P daemon is online.

Modes:
  full  -> preload the full MLX model when the allocated memory is large enough.
  shard -> assign and download the largest GGUF shard that fits the allocation.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PY_DIR = ROOT / "python-inference"
sys.path.insert(0, str(PY_DIR))

import grpc  # type: ignore
import vryx_pb2  # type: ignore
import vryx_pb2_grpc  # type: ignore


LLAMA2_70B_SUMMARY = "/api/internal/shard-serve/prepared-llama2-70b-gguf-vram-test/summary.json"


def _call(grpc_port: int, dtype: str, payload: dict, timeout: int = 900) -> dict:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with grpc.insecure_channel(f"127.0.0.1:{grpc_port}") as channel:
        stub = vryx_pb2_grpc.InferenceServiceStub(channel)
        response = stub.Process(vryx_pb2.TensorData(data=raw, dtype=dtype), timeout=timeout)
    try:
        return json.loads(bytes(response.data).decode("utf-8", errors="replace"))
    except Exception:
        return {
            "ok": False,
            "raw_b64": base64.b64encode(bytes(response.data)).decode("ascii"),
        }


def _fetch_json(url: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _choose_manifest(summary: dict, allocated_gb: float) -> dict:
    manifests = [m for m in summary.get("manifests") or [] if isinstance(m, dict)]
    if not manifests:
        raise RuntimeError("aucun manifeste de shard disponible")
    budget_bytes = max(0.25, (allocated_gb - min(1.5, max(0.75, allocated_gb * 0.06))) * 0.92) * 1024**3
    fitting = [m for m in manifests if int(m.get("bytes") or 0) <= budget_bytes]
    candidates = fitting or manifests
    return max(candidates, key=lambda m: int(m.get("bytes") or 0))


def _prepare_full(args: argparse.Namespace) -> int:
    load_model_id = os.environ.get("VRYX_MLX_LM_MODEL_ID") or args.model_id
    payload = {
        "model_id": args.model_id,
        "load_model_id": load_model_id,
        "quantization": args.quantization,
    }
    print(f"[residency] Full preload MLX: model={args.model_id} load={load_model_id}")
    result = _call(args.grpc_port, "vryx.mlx_lm.preload", payload, timeout=args.timeout_sec)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


def _prepare_shard(args: argparse.Namespace) -> int:
    if "llama-2-70b" not in args.model_id.lower() and "70b" not in args.model_id.lower():
        print("[residency] Aucun shard local automatique pour ce modèle.")
        return 0
    base = args.api_url.rstrip("/")
    summary_url = f"{base}{LLAMA2_70B_SUMMARY}"
    summary = _fetch_json(summary_url)
    manifest = _choose_manifest(summary, args.allocated_gb)
    session_id = f"local-{args.model_id.lower().replace('/', '-').replace(':', '-')}-{int(time.time())}"
    payload = {
        "session_id": session_id,
        "pool_id": "local-residency",
        "model_id": args.model_id,
        "model_config": {
            "_model_id": args.model_id,
            "model_type": "llama",
            "hidden_size": 8192,
            "intermediate_size": 28672,
            "num_hidden_layers_total": 80,
            "num_attention_heads": 64,
            "num_key_value_heads": 8,
            "vocab_size": 32000,
            "rms_norm_eps": 1e-5,
        },
        "ttl_sec": 86400,
        "layer_start": int(manifest.get("layer_start") or 0),
        "layer_end": int(manifest.get("layer_end") or 0),
        "has_embedding": bool(manifest.get("has_embedding")),
        "has_lm_head": bool(manifest.get("has_lm_head")),
        "download_url": str(manifest.get("download_url") or ""),
        "async_load": True,
        "runtime_backend": "mlx",
        "weight_quantization": args.quantization,
        "supports_mlx": True,
        "supports_q4_weights": args.quantization.lower() in ("q4", "int4"),
        "hidden_transport": args.quantization,
    }
    print(
        "[residency] Shard assigné: "
        f"layers={payload['layer_start']}-{payload['layer_end']} "
        f"gb={float(manifest.get('gb') or 0):.2f} url={payload['download_url']}"
    )
    result = _call(args.grpc_port, "vryx.shard.init", payload, timeout=30)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["full", "shard"], required=True)
    parser.add_argument("--grpc-port", type=int, default=50052)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--allocated-gb", type=float, default=0)
    parser.add_argument("--quantization", default="q4")
    parser.add_argument("--api-url", default="https://vryx.eu")
    parser.add_argument("--timeout-sec", type=int, default=900)
    args = parser.parse_args()
    if args.mode == "full":
        return _prepare_full(args)
    return _prepare_shard(args)


if __name__ == "__main__":
    raise SystemExit(main())
