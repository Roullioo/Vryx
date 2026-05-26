#!/usr/bin/env python3
"""Smoke test for VRYX chain stream M1 -> M4 without loading/running a model."""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


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


def fetch_peers(api_url: str, timeout: float) -> list[str]:
    with urllib.request.urlopen(f"{api_url.rstrip('/')}/api/tp-peers", timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    peers = body.get("peers") or []
    if len(peers) < 2:
        raise SystemExit(f"Need at least 2 peers, got {len(peers)}: {body}")
    return [str(p) for p in peers[:2]]


def run_case(api_url: str, source_peer: str, target_peer: str, test: str, payload_bytes: int, timeout: float) -> bool:
    t0 = time.perf_counter()
    body = {
        "source_peer": source_peer,
        "target_peer": target_peer,
        "test": test,
        "payload_bytes": payload_bytes,
        "session_id": "chain-smoke",
        "request_id": f"chain-smoke-{test}-{payload_bytes}-{time.time_ns()}",
    }
    if test == "fake_tensor":
        body.update({"tensor_dtype": "fp16", "shape": [1, max(1, payload_bytes // 2)]})
    result = post_json(f"{api_url.rstrip('/')}/api/p2p/chain-test", body, timeout)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    ok = bool(result.get("ok"))
    response = result.get("response") if isinstance(result.get("response"), dict) else {}
    print(json.dumps({
        "ok": ok,
        "test": test,
        "payload_bytes": payload_bytes,
        "elapsed_ms": elapsed_ms,
        "latency_ms": result.get("latency_ms"),
        "chain_roundtrip_ms": result.get("chain_roundtrip_ms"),
        "chain_type": response.get("chain_type"),
        "checksum": response.get("checksum"),
        "error": result.get("error") or response.get("error"),
    }, ensure_ascii=False))
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:3031")
    parser.add_argument("--source-peer", default="", help="M1 peer id. Defaults to first /api/tp-peers peer.")
    parser.add_argument("--target-peer", default="", help="M4 peer id. Defaults to second /api/tp-peers peer.")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    source_peer = args.source_peer
    target_peer = args.target_peer
    if not source_peer or not target_peer:
        peers = fetch_peers(args.api_url, args.timeout)
        source_peer = source_peer or peers[0]
        target_peer = target_peer or peers[1]

    cases = [
        ("ping", 0),
        ("echo", 8 * 1024),
        ("echo", 64 * 1024),
        ("echo", 1024 * 1024),
        ("fake_tensor", 64 * 1024),
    ]
    print(json.dumps({"source_peer": source_peer, "target_peer": target_peer, "cases": cases}, ensure_ascii=False))
    all_ok = True
    for test, payload_bytes in cases:
        all_ok = run_case(args.api_url, source_peer, target_peer, test, payload_bytes, args.timeout) and all_ok
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
