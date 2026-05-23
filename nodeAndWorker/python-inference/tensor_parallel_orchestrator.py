"""
Orchestration tensor-parallel réelle via le relais P2P du daemon Rust.

Découpe **par lignes** de W (row-split) : chaque worker reçoit une bande
`(h_k, in_dim)` au lieu de la matrice entière, donc ~1/K des FLOPs du gemm+relu
par pair, puis l'initiateur concatène les sorties (équivalent à une seule couche
dense si on ignorait ReLU intermédiaire — ici chaque worker fait ReLU sur sa bande,
ce qui correspond au TP « partition de sortie » avec activation locale).

Variables :
  VRYX_TP_ENABLED=1          — active le calcul tensor-parallel P2P (stage 1).
  VRYX_P2P_RELAY_URL         — ex. http://127.0.0.1:3031
  VRYX_TP_PEER_IDS           — liste de PeerId (prioritaire si non vide).
  VRYX_TP_USE_ALL_PEERS      — si vide et pas « 0 »/« false »/« no » : GET /api/tp-peers.
"""
from __future__ import annotations

import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import numpy as np

import gguf_reader


def _relay_url() -> str:
    return os.environ.get("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031").rstrip("/")


def _tp_peer_ids_from_env() -> list[str]:
    raw = os.environ.get("VRYX_TP_PEER_IDS", "").strip()
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def _tp_use_all_peers_default() -> bool:
    raw = os.environ.get("VRYX_TP_USE_ALL_PEERS", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return True


def _fetch_tp_peers_from_relay() -> list[str]:
    url = f"{_relay_url()}/api/tp-peers"
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=15.0) as resp:
        j = json.loads(resp.read().decode("utf-8"))
    if not j.get("ok", True) and j.get("error"):
        return []
    peers = j.get("peers")
    if not isinstance(peers, list):
        return []
    out: list[str] = []
    for p in peers:
        if isinstance(p, str) and p.strip():
            out.append(p.strip())
    return out


def _resolve_tp_peer_ids() -> list[str]:
    explicit = _tp_peer_ids_from_env()
    if explicit:
        return explicit
    if not _tp_use_all_peers_default():
        return []
    return _fetch_tp_peers_from_relay()


def _relay_post(target_peer: str, dtype: str, payload_bytes: bytes, timeout_sec: float = 15.0) -> dict[str, Any]:
    url = f"{_relay_url()}/api/p2p/relay"
    body = json.dumps(
        {
            "target_peer": target_peer,
            "dtype": dtype,
            "data_b64": base64.standard_b64encode(payload_bytes).decode("ascii"),
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _build_weight_npy_bytes(hidden: int, seed: int) -> tuple[bytes, np.ndarray, np.ndarray]:
    w, b = gguf_reader.synthetic_linear_weights(hidden, seed)
    buf = io.BytesIO()
    np.savez(buf, W=w, b=b)
    return buf.getvalue(), w, b


def _maybe_gguf_weights() -> tuple[bytes, np.ndarray, np.ndarray] | None:
    path = os.environ.get("VRYX_GGUF_PATH", "").strip()
    if not path:
        return None
    layer = int(os.environ.get("VRYX_TP_GGUF_LAYER", "0"))
    sl = gguf_reader.load_ffn_down_slice(path, layer, max_rows=int(os.environ.get("VRYX_TP_GGUF_MAX_ROWS", "128")))
    if not sl:
        return None
    mat, name = sl
    h = min(mat.shape[0], mat.shape[1], int(os.environ.get("VRYX_TP_HIDDEN", "128")))
    w = mat[:h, :h].astype(np.float32, copy=True)
    b = np.zeros((h,), dtype=np.float32)
    buf = io.BytesIO()
    np.savez(buf, W=w, b=b, source_tensor=name)
    return buf.getvalue(), w, b


def _split_row_slices(h: int, k: int) -> list[tuple[int, int]]:
    """K intervalles [start, end) couvrant [0, h), charges équilibrées."""
    if k <= 0:
        return []
    base = h // k
    rem = h % k
    out: list[tuple[int, int]] = []
    start = 0
    for i in range(k):
        nrows = base + (1 if i < rem else 0)
        end = start + nrows
        out.append((start, end))
        start = end
    return out


def _npz_bytes_for_slice(W: np.ndarray, b: np.ndarray, row_start: int, row_end: int) -> bytes:
    w_sub = W[row_start:row_end, :].astype(np.float32, copy=False)
    b_sub = b[row_start:row_end].astype(np.float32, copy=False)
    buf = io.BytesIO()
    np.savez(buf, W=w_sub, b=b_sub)
    return buf.getvalue()


def _one_peer_row_forward(
    peer: str,
    rank: int,
    base_session: str,
    weight_bytes: bytes,
    act_bytes: bytes,
    chunk_size: int,
) -> dict[str, Any]:
    """Init → load chunks → forward → unload sur un seul pair (bande de lignes)."""
    session_id = f"{base_session}-r{rank}"
    t0 = time.perf_counter()

    body_init = {
        "session_id": session_id,
        "ttl_sec": 600,
        "layer_start": rank,
        "layer_end": rank,
        "model_tag": "vryx.tp",
    }
    r_init = _relay_post(peer, "vryx.tp.init", json.dumps(body_init).encode("utf-8"))
    if not r_init.get("ok", True) and r_init.get("error"):
        return {"ok": False, "rank": rank, "peer": peer, "error": r_init.get("error"), "latency_ms": 0.0}

    chunks: list[bytes] = []
    for i in range(0, len(weight_bytes), chunk_size):
        chunks.append(weight_bytes[i : i + chunk_size])
    for ci, ch in enumerate(chunks):
        body_load = {
            "session_id": session_id,
            "chunk_index": ci,
            "chunk_total": len(chunks),
            "payload_b64": base64.standard_b64encode(ch).decode("ascii"),
        }
        r_load = _relay_post(peer, "vryx.tp.load", json.dumps(body_load).encode("utf-8"))
        if not r_load.get("ok", True) and r_load.get("error"):
            return {"ok": False, "rank": rank, "peer": peer, "error": r_load.get("error"), "latency_ms": 0.0}

    body_fwd = {
        "session_id": session_id,
        "layer_id": rank,
        "activation_b64": base64.standard_b64encode(act_bytes).decode("ascii"),
    }
    r_fwd = _relay_post(peer, "vryx.tp.forward", json.dumps(body_fwd).encode("utf-8"))
    if not r_fwd.get("ok", True) and r_fwd.get("error"):
        return {"ok": False, "rank": rank, "peer": peer, "error": r_fwd.get("error"), "latency_ms": 0.0}

    out_b64 = r_fwd.get("data_b64") or ""
    out_bytes = base64.standard_b64decode(out_b64)

    body_unload = {"session_id": session_id}
    try:
        _relay_post(peer, "vryx.tp.unload", json.dumps(body_unload).encode("utf-8"))
    except urllib.error.URLError:
        pass

    dt_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "ok": True,
        "rank": rank,
        "peer": peer,
        "latency_ms": round(dt_ms, 3),
        "activation_bytes": len(out_bytes),
        "out_bytes": out_bytes,
    }


def run_row_split_tensor_parallel(peer_ids: list[str]) -> dict[str, Any]:
    """
    Une entrée x, W découpée en K bandes de lignes, K workers en parallèle,
    concaténation des sorties ReLU (même x, pas de pipeline séquentiel sur les activations).
    """
    if len(peer_ids) < 1:
        return {"ok": False, "error": "aucun peer", "steps": [], "layout": "row_split_tensor_parallel"}

    k = len(peer_ids)
    hidden = int(os.environ.get("VRYX_TP_HIDDEN", "128"))
    base_session = f"tp-{int(time.time() * 1000)}"
    chunk_size = int(os.environ.get("VRYX_TP_CHUNK_BYTES", str(256 * 1024)))

    gguf_t = _maybe_gguf_weights()
    used_gguf = gguf_t is not None
    if gguf_t is not None:
        _, W, b = gguf_t
    else:
        weight_bytes_full, W, b = _build_weight_npy_bytes(hidden, seed=42)
        _ = weight_bytes_full

    h, in_dim = W.shape[0], W.shape[1]
    if b.shape[0] != h:
        return {"ok": False, "error": "shape b incompatible avec W", "layout": "row_split_tensor_parallel"}

    slices = _split_row_slices(h, k)
    rng = np.random.default_rng(123)
    x = rng.standard_normal((in_dim,), dtype=np.float32)
    x = x / (np.linalg.norm(x) + 1e-6)
    act_bytes = x.tobytes()

    # Référence locale (concat ReLU par bande != ReLU global ; on compare quand même au gemm complet + ReLU pour info)
    y_ref = np.maximum(0.0, x @ W.T + b).astype(np.float32)

    per_peer_weights: list[bytes] = []
    for rank, (rs, re) in enumerate(slices):
        per_peer_weights.append(_npz_bytes_for_slice(W, b, rs, re))

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=k) as ex:
        futs = {
            ex.submit(
                _one_peer_row_forward,
                peer_ids[rank],
                rank,
                base_session,
                per_peer_weights[rank],
                act_bytes,
                chunk_size,
            ): rank
            for rank in range(k)
        }
        for fut in as_completed(futs):
            results.append(fut.result())

    failures = [r for r in results if not r.get("ok")]
    if failures:
        err = failures[0].get("error", "erreur inconnue")
        return {
            "ok": False,
            "error": err,
            "layout": "row_split_tensor_parallel",
            "tensor_parallel_layout": "row_split",
            "pipeline_workers": k,
            "peers_used": k,
            "peers": peer_ids,
            "steps": results,
        }

    results.sort(key=lambda r: int(r["rank"]))
    parts: list[np.ndarray] = []
    step_trace: list[dict[str, Any]] = []
    for r in results:
        ob = r.get("out_bytes", b"")
        yp = np.frombuffer(ob, dtype=np.float32).copy()
        parts.append(yp)
        step_trace.append(
            {
                "peer": r["peer"],
                "rank": r["rank"],
                "role": "row_split",
                "latency_ms": r["latency_ms"],
                "activation_bytes": r["activation_bytes"],
                "out_rows": int(yp.size),
            }
        )

    y_cat = np.concatenate(parts, axis=0) if parts else np.array([], dtype=np.float32)
    max_abs = float(np.max(np.abs(y_cat - y_ref))) if y_cat.size == y_ref.size else None

    return {
        "ok": True,
        "session_id": base_session,
        "hidden": hidden,
        "in_dim": in_dim,
        "out_dim": h,
        "layout": "row_split_tensor_parallel",
        "tensor_parallel_layout": "row_split",
        "pipeline_workers": k,
        "scheduler_workers_used": k,
        "peers_used": k,
        "peers": peer_ids,
        "parallel_fanout": k,
        "used_gguf": used_gguf,
        "max_abs_error_vs_full_dense_relu": max_abs,
        "note": (
            "Sortie = concat(ReLU(W_k @ x + b_k)) ; la référence `full_dense_relu` applique ReLU sur Wx+b entier, "
            "donc l'écart peut être non nul même si le TP est correct pour la partition par sorties."
        ),
        "steps": step_trace,
    }


def _fetch_tp_peers_from_express() -> list[str]:
    """Fallback : interroge l'API Express interne (localhost uniquement) pour les workers live."""
    internal_token = os.getenv("VRYX_INTERNAL_TOKEN", "vryx-internal-localhost")
    for port in (48953, 4000, 3000):
        try:
            url = f"http://127.0.0.1:{port}/api/internal/live-peers"
            req = urllib.request.Request(url, method="GET", headers={"X-Internal-Token": internal_token})
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                j = json.loads(resp.read().decode("utf-8"))
            if j.get("ok") and isinstance(j.get("peers"), list):
                return [p for p in j["peers"] if isinstance(p, str) and p.strip()]
        except Exception:
            continue
    return []


def _resolve_tp_peer_ids_auto() -> list[str]:
    """Résolution complète : env → relay → Express API interne."""
    explicit = _tp_peer_ids_from_env()
    if explicit:
        return explicit

    # Tentative via relay Rust /api/tp-peers
    try:
        from_relay = _fetch_tp_peers_from_relay()
        if from_relay:
            return from_relay
    except Exception:
        pass

    # Fallback : API Express interne
    return _fetch_tp_peers_from_express()


def maybe_run_tensor_parallel() -> dict[str, Any] | None:
    # Désactivation explicite seulement
    disabled = os.environ.get("VRYX_TP_ENABLED", "").strip().lower()
    if disabled in ("0", "false", "no", "off"):
        return None

    peers = _resolve_tp_peer_ids_auto()
    if len(peers) < 1:
        return None
    # Limiter à 2 workers max pour rester dans le timeout HTTP (240s)
    max_workers = int(os.environ.get("VRYX_TP_MAX_WORKERS", "2"))
    peers = peers[:max_workers]
    print(f"[TP] {len(peers)} pair(s) disponibles, lancement tensor parallel : {peers}")
    try:
        return run_row_split_tensor_parallel(peers)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = str(e)
        return {
            "ok": False,
            "error": f"HTTP {e.code}: {body[:500]}",
            "steps": [],
            "layout": "row_split_tensor_parallel",
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "steps": [], "layout": "row_split_tensor_parallel"}
