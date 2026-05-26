#!/usr/bin/env python3
"""Replay a captured M1 chain output payload directly against M4 via /api/p2p/pipeline-stream."""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
import urllib.error
from pathlib import Path


def post_json(url: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"ok": False, "error": body}
        parsed.setdefault("ok", False)
        parsed.setdefault("http_status", exc.code)
        return parsed


def fetch_second_peer(api_url: str, timeout: float) -> str:
    with urllib.request.urlopen(f"{api_url.rstrip('/')}/api/tp-peers", timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    peers = body.get("peers") or []
    if len(peers) < 2:
        raise SystemExit(f"Need at least 2 peers, got {len(peers)}: {body}")
    return str(peers[1])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", help="Path to vryx-chain-m1-output-*.json")
    parser.add_argument("--api-url", default="http://127.0.0.1:3031")
    parser.add_argument("--target-peer", default="", help="M4 peer id. Defaults to second /api/tp-peers peer.")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    capture = json.loads(Path(args.capture).read_text())
    target_peer = args.target_peer or capture.get("target_peer") or fetch_second_peer(args.api_url, args.timeout)
    session_id = str(capture.get("session_id") or "m4-replay")
    request_id = f"m4-replay-{time.time_ns()}"
    step_id = int(capture.get("step_id") or 0)
    dtype = str(capture.get("forward_dtype") or "vryx.shard.pipeline")
    payload_b64 = str(capture.get("payload_b64") or "")
    body = {
        "target_peer": target_peer,
        "dtype": dtype,
        "data_b64": payload_b64,
        "session_id": session_id,
        "request_id": request_id,
        "step_id": step_id,
    }
    t0 = time.perf_counter()
    result = post_json(f"{args.api_url.rstrip('/')}/api/p2p/pipeline-stream", body, args.timeout)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    relay_trace = result.get("relay_trace") if isinstance(result.get("relay_trace"), dict) else {}
    print(json.dumps({
        "ok": bool(result.get("ok")),
        "target_peer": target_peer,
        "dtype": dtype,
        "payload_len": capture.get("payload_len"),
        "elapsed_ms": elapsed_ms,
        "relay_ms": result.get("relay_ms"),
        "worker_compute_ms": result.get("worker_compute_ms"),
        "compute_time_ms": result.get("compute_time_ms"),
        "stream_reused": relay_trace.get("stream_reused"),
        "stream_roundtrip_ms": relay_trace.get("stream_roundtrip_ms"),
        "request_response_fallback": result.get("request_response_fallback"),
        "error": result.get("error"),
    }, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
