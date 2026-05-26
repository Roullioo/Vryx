#!/usr/bin/env python3
"""Smoke-test Vryx pipeline warmup without entering decode."""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lk = str(key).lower()
            if "secret" in lk or lk == "token" or lk.endswith("_token"):
                out[key] = "REDACTED" if item else item
            else:
                out[key] = _redact(item)
        return out
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"([?&]token=)[^\"'&\\s)]+", r"\1REDACTED", value)
    return value


def _post(url: str, payload: dict[str, Any], timeout: float) -> tuple[int, dict[str, Any], int]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", errors="replace")), int((time.perf_counter() - started) * 1000)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"ok": False, "error": raw[:2000]}
        return exc.code, parsed, int((time.perf_counter() - started) * 1000)
    except (TimeoutError, socket.timeout) as exc:
        return 599, {"ok": False, "error": f"http_timeout:{exc}"}, int((time.perf_counter() - started) * 1000)
    except Exception as exc:
        return 598, {"ok": False, "error": f"http_error:{type(exc).__name__}:{exc}"}, int((time.perf_counter() - started) * 1000)


def _trace(data: dict[str, Any]) -> dict[str, Any]:
    if isinstance(data.get("pipeline_trace"), dict):
        return data["pipeline_trace"]
    if isinstance(data.get("trace"), dict):
        return data["trace"]
    return {}


def _status_ready(worker_statuses: list[Any], session_id: str) -> bool:
    if not worker_statuses:
        return False
    for status in worker_statuses:
        if not isinstance(status, dict):
            return False
        shards = status.get("shards") if isinstance(status.get("shards"), list) else []
        hit = next((s for s in shards if isinstance(s, dict) and s.get("session_id") == session_id), None)
        if not hit:
            return False
        if not (hit.get("ready") or hit.get("built") or hit.get("build_ready")):
            return False
        if int(hit.get("weights_loaded") or 0) <= 0:
            return False
    return True


def _summary(label: str, status: int, data: dict[str, Any], wall_ms: int) -> dict[str, Any]:
    trace = _trace(data)
    call_counts = trace.get("call_counts") if isinstance(trace.get("call_counts"), dict) else {}
    phase = trace.get("phase_trace") if isinstance(trace.get("phase_trace"), dict) else {}
    pool_validation = trace.get("pool_validation") if isinstance(trace.get("pool_validation"), dict) else {}
    worker_statuses = trace.get("worker_statuses") if isinstance(trace.get("worker_statuses"), list) else []
    session_id = str(trace.get("session_id") or "")
    ready = bool(pool_validation.get("ready")) or _status_ready(worker_statuses, session_id)
    request_ok = bool(data.get("ok")) and status < 400
    warmup_ready = ready and bool(session_id)
    return {
        "label": label,
        "http_status": status,
        "ok": request_ok or warmup_ready,
        "error": data.get("error"),
        "post_warmup_error": data.get("error") if warmup_ready and not request_ok else None,
        "client_wall_ms": wall_ms,
        "session_id": session_id,
        "session_status": trace.get("session_status"),
        "session_reused": trace.get("session_reused"),
        "session_reuse_reason": trace.get("session_reuse_reason"),
        "routing_path": trace.get("routing_path"),
        "init_only": int(call_counts.get("vryx.shard.init") or 0) > 0 or trace.get("session_reused") is True,
        "load_only": int(phase.get("shard_load_ms") or 0) > 0 or ready,
        "build_only": int(phase.get("shard_build_ms") or 0) > 0 or ready,
        "status_ready": ready,
        "shard_init_calls": int(call_counts.get("vryx.shard.init") or 0),
        "shard_status_calls": int(call_counts.get("vryx.shard.status") or 0),
        "phase_trace": phase,
        "pool_validation": pool_validation,
        "worker_statuses": worker_statuses,
        "shard_prep_diag": trace.get("shard_prep_diag"),
    }


def main() -> int:
    url = os.environ.get("VRYX_WARMUP_SMOKE_URL", "http://127.0.0.1:3031/api/chat")
    timeout = float(os.environ.get("VRYX_WARMUP_SMOKE_TIMEOUT", "360"))
    payload = {
        "prompt": os.environ.get("VRYX_WARMUP_SMOKE_PROMPT", "warmup only"),
        "max_new_tokens": int(os.environ.get("VRYX_WARMUP_SMOKE_TOKENS", "1")),
        "quantization": os.environ.get("VRYX_WARMUP_SMOKE_QUANT", "fp16"),
        "pool_preference": os.environ.get("VRYX_WARMUP_SMOKE_POOL", "auto"),
        "force_distributed": True,
        "load_mode": "shard",
        "chain_stream": False,
        "chain_result_direct": False,
        "decode_microbatch_cap": 1,
        "warmup_only": True,
    }
    status, data, wall_ms = _post(url, payload, timeout)
    first = _summary("warmup_only", status, data, wall_ms)
    print(json.dumps(_redact(first), ensure_ascii=False, sort_keys=True))
    if not first["ok"] or not first["status_ready"]:
        return 1
    status2, data2, wall2 = _post(url, payload, timeout)
    second = _summary("warmup_only_reuse", status2, data2, wall2)
    print(json.dumps(_redact(second), ensure_ascii=False, sort_keys=True))
    if not second["ok"] or second.get("session_reused") is not True or not second["status_ready"]:
        return 2
    print(json.dumps({"ok": True, "session_id": second.get("session_id"), "session_reused": True}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
