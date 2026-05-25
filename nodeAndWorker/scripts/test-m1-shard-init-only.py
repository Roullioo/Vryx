#!/usr/bin/env python3
"""Smoke test ciblé M1: envoie uniquement vryx.shard.init à un peer.

Variables utiles:
  VRYX_M1_PEER_ID              PeerId M1 à tester.
  VRYX_P2P_RELAY_URL           URL relay initiator, défaut http://127.0.0.1:3030.
  VRYX_TEST_MODEL_ID           Défaut Qwen/Qwen3.6-35B-A3B.
  VRYX_TEST_LAYER_START/END    Défaut 0/19.

Ce test ne lance pas hot12/hot24 et n'envoie pas de shard.load/build.
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[1] / "python-inference"
sys.path.insert(0, str(ROOT))

os.environ.setdefault("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3030")

import distributed_llm_orchestrator as orch  # noqa: E402


def main() -> int:
    peer_id = os.environ.get("VRYX_M1_PEER_ID", "").strip()
    if not peer_id:
        print("missing VRYX_M1_PEER_ID", file=sys.stderr)
        return 2
    session_id = f"m1-shard-init-only-{int(time.time())}"
    model_id = os.environ.get("VRYX_TEST_MODEL_ID", "Qwen/Qwen3.6-35B-A3B")
    layer_start = int(os.environ.get("VRYX_TEST_LAYER_START", "0"))
    layer_end = int(os.environ.get("VRYX_TEST_LAYER_END", "19"))
    payload = {
        "session_id": session_id,
        "pool_id": "m1-shard-init-only",
        "model_id": model_id,
        "layer_start": layer_start,
        "layer_end": layer_end,
        "model_config": {
            "model_type": "qwen3_moe",
            "num_hidden_layers": 40,
            "hidden_size": 2048,
            "num_attention_heads": 32,
            "num_key_value_heads": 8,
            "intermediate_size": 6144,
            "vocab_size": 151936,
        },
        "has_embedding": layer_start == 0,
        "has_lm_head": False,
        "ttl_sec": 600,
        "async_load": True,
        "runtime_backend": "mlx_lm",
        "weight_quantization": "q4",
        "supports_mlx": True,
        "supports_q4_weights": True,
    }
    started = time.perf_counter()
    result = orch._relay_raw(
        peer_id,
        "vryx.shard.init",
        json.dumps(payload).encode("utf-8"),
        timeout=orch.timeout_for_dtype("vryx.shard.init"),
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    inner = {}
    if result.get("data_b64"):
        try:
            inner = json.loads(base64.b64decode(result["data_b64"]).decode("utf-8", errors="replace"))
        except Exception as exc:
            inner = {"decode_error": str(exc)}
    print(json.dumps({
        "ok": result.get("ok") is not False and inner.get("ok", True) is not False,
        "elapsed_ms": elapsed_ms,
        "relay": result,
        "worker": inner,
    }, ensure_ascii=False, indent=2))
    if result.get("ok") is False or inner.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
