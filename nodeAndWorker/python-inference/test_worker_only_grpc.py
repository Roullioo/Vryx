#!/usr/bin/env python3
"""
Test direct gRPC (sans /api/chat Rust) : stage 1 + worker-only + relais HTTP local.
À lancer lorsque sont déjà actifs sur la même machine :
  - rust-daemon initiator (--api-port 3030, --grpc-port 50051)
  - rust-daemon worker (--api-port 3031, --grpc-port 50052)
  - inference_server stage 2 port 50052
  - inference_server stage 1 port 50051 avec VRYX_WORKER_ONLY_LLM=1, VRYX_P2P_RELAY_URL,
    VRYX_TP_PEER_IDS=<PeerId du worker>

Usage :
  export VRYX_WORKER_ONLY_LLM=1 VRYX_P2P_RELAY_URL=http://127.0.0.1:3030 VRYX_TP_PEER_IDS=12D3Koo...
  python3 test_worker_only_grpc.py
"""
from __future__ import annotations

import os
import sys

import grpc

import vryx_pb2
import vryx_pb2_grpc


def main() -> int:
    host = os.environ.get("VRYX_GRPC_TEST_HOST", "127.0.0.1")
    port = int(os.environ.get("VRYX_GRPC_TEST_PORT", "50051"))
    if os.environ.get("VRYX_WORKER_ONLY_LLM", "").strip().lower() not in ("1", "true", "yes", "on"):
        print("Définissez VRYX_WORKER_ONLY_LLM=1", file=sys.stderr)
        return 2
    ch = grpc.insecure_channel(f"{host}:{port}")
    stub = vryx_pb2_grpc.InferenceServiceStub(ch)
    prompt = os.environ.get("VRYX_TEST_PROMPT", "Test gRPC worker-only.")
    req = vryx_pb2.TensorData(data=prompt.encode("utf-8"), dtype="text")
    resp = stub.Process(req, timeout=120.0)
    text = resp.data.decode("utf-8", errors="replace")
    print("--- ProcessedTensorData ---")
    print("prompt_tokens:", resp.prompt_tokens)
    print("completion_tokens:", resp.completion_tokens)
    print("total_tokens:", resp.total_tokens)
    print("vps_delegate_ms:", resp.vps_delegate_ms)
    print("pipeline_trace_json (extrait):", (resp.pipeline_trace_json or "")[:400])
    print("--- texte ---")
    print(text[:2000])
    ch.close()
    if "Ollama local indisponible" in text:
        print("ÉCHEC : message Ollama (worker-only non actif ?)", file=sys.stderr)
        return 1
    if "worker-only" in text.lower() or "worker_only_pipeline" in (resp.pipeline_trace_json or ""):
        return 0
    if resp.completion_tokens and resp.completion_tokens > 0:
        return 0
    print("ÉCHEC : pas de trace worker-only détectée", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
