#!/usr/bin/env python3
"""Mesure TPS depuis POST /api/chat (initiateur local). Premier tour = warmup, second = mesure.

Usage :
  cd nodeAndWorker && ./scripts/bench_local_chat_tps.py
  VRYX_BENCH_URL=http://127.0.0.1:3030/api/chat VRYX_BENCH_TOKENS=96 ./scripts/bench_local_chat_tps.py
  VRYX_BENCH_QUICK=1 ./scripts/bench_local_chat_tps.py   # moins de tokens, timeout HTTP plus court
  # Pousser le micro-batch MLX : export VRYX_DECODE_MICROBATCH_CAP=64 avant de relancer quick-local-p2p / les workers.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


def one_chat(url: str, prompt: str, max_new_tokens: int, http_timeout_sec: float) -> dict:
    payload = {
        "prompt": prompt,
        "max_new_tokens": max_new_tokens,
        "quantization": os.environ.get("VRYX_BENCH_QUANT", "fp16"),
        "pool_preference": os.environ.get("VRYX_BENCH_POOL", "velocity_mlx"),
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    wall0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=http_timeout_sec) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    wall_ms = int((time.perf_counter() - wall0) * 1000)
    data = json.loads(raw)
    data["_wall_ms"] = wall_ms
    return data


def main() -> int:
    url = os.environ.get("VRYX_BENCH_URL", "http://127.0.0.1:3030/api/chat").rstrip("/")
    if url.endswith("/api/status"):
        url = url.replace("/api/status", "/api/chat")
    if not url.endswith("/api/chat"):
        url = url.rstrip("/") + "/api/chat"
    quick = os.environ.get("VRYX_BENCH_QUICK", "").strip() in ("1", "true", "yes", "on")
    default_nt = "24" if quick else "48"
    nt = int(os.environ.get("VRYX_BENCH_TOKENS", default_nt))
    http_timeout = float(
        os.environ.get("VRYX_BENCH_HTTP_TIMEOUT", "120" if quick else "300")
    )
    p_warm = os.environ.get(
        "VRYX_BENCH_PROMPT_WARM",
        "Réponds uniquement par un seul chiffre : 0",
    )
    default_meas = (
        "Liste les entiers de 1 à 12 inclus, une ligne par nombre, sans autre texte."
        if quick
        else (
            "Continue strictement la série numérique sans texte autour, une entrée par ligne, "
            "de 1 jusqu'à 52 inclusivement (format : chaque ligne = un entier)."
        )
    )
    p_meas = os.environ.get("VRYX_BENCH_PROMPT", default_meas)

    print(f"[bench] POST {url} max_new_tokens={nt} http_timeout={http_timeout}s quick={quick}", flush=True)
    try:
        w = one_chat(url, p_warm, min(nt, 16 if quick else 24), http_timeout)
    except urllib.error.HTTPError as e:
        print(f"[bench] warmup HTTP {e.code}: {e.read().decode()[:800]}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[bench] warmup erreur : {e}", file=sys.stderr)
        return 1
    ok_w = w.get("ok") is True
    print(f"[bench] warmup ok={ok_w} wall_ms={w.get('_wall_ms')} ct={w.get('completion_tokens')}", flush=True)

    t0 = time.perf_counter()
    r = one_chat(url, p_meas, nt, http_timeout)
    outer_ms = int((time.perf_counter() - t0) * 1000)
    if r.get("ok") is not True:
        err = r.get("error") or r
        print(f"[bench] mesure échec : {err}", file=sys.stderr)
        return 1

    ct = int(r.get("completion_tokens") or 0)
    min_ct_warn = max(8, nt // 4) if quick else max(15, nt // 3)
    if ct < min_ct_warn:
        print(
            f"[bench] Attention : completion_tokens={ct} << demande (~{nt}) — métrique TPS peu fiable "
            "(génération stoppée tôt EOS/stop/UI, pile pas relancée, ou plafond d’ENV). "
            "Relance `./quick-local-p2p.sh stop && ./quick-local-p2p.sh start` puis réessaie.",
            file=sys.stderr,
        )

    lat = int(r.get("latency_ms") or r.get("_wall_ms") or outer_ms)
    wall = int(r.get("_wall_ms") or lat)
    if ct <= 0:
        print("[bench] completion_tokens=0 ; impossible dériver TPS", file=sys.stderr)
        return 1

    bench = (((r.get("pipeline_trace") or {}) if isinstance(r.get("pipeline_trace"), dict) else {}).get("benchmark") or {})
    proclaimed = bench.get("actual_tps")

    raw_tps = (1000.0 * ct / float(wall)) if wall > 0 else 0.0
    srv_tps = (1000.0 * ct / float(lat)) if lat > 0 else 0.0
    print(
        f"[bench] résultat : completion_tokens={ct} wall_ms≈{wall} latency_ms={lat} "
        f"TPS_wall≈{raw_tps:.2f} TPS_latency≈{srv_tps:.2f} "
        f"(trace.benchmark.actual_tps={proclaimed})",
        flush=True,
    )
    if bench:
        hk = bench.get("hot_path_tps")
        if hk is not None:
            print(f"[bench] hot_path_tps dans trace={hk}", flush=True)

    threshold = float(os.environ.get("VRYX_BENCH_TARGET_TPS", "10"))
    if raw_tps >= threshold:
        print(f"[bench] seuil ≥ {threshold:g} TPS atteint (sur wall_ms)", flush=True)
        return 0
    print(
        f"[bench] sous le seuil {threshold:g} TPS ; "
        f"essayez MLX (VRYX_RUNTIME_BACKEND=mlx), cap micro-batch "
        f"(VRYX_DECODE_MICROBATCH_CAP), modèle plus petit, ou machine plus rapide.",
        flush=True,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
