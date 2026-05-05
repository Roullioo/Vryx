"""
Runtime shard éphémère (RAM uniquement).

- Sessions classiques (`model_tag` autre que `vryx.tp`) : forward XOR déterministe (compat).
- Pipeline tensor-parallel (`vryx.tp`) : vraies opérations numpy (linéaire + ReLU) sur poids
  reçus par chunks (`shard_load` / `vryx.tp.load`).
- Pipeline distribué (`vryx.dist`) : chaîne worker-only (embedding token optionnel + ReLU + logits).
"""
from __future__ import annotations

import hashlib
import io
import struct
import time
from dataclasses import dataclass

import numpy as np


@dataclass
class EphemeralShardSession:
    session_id: str
    layer_start: int
    layer_end: int
    created_ns: int
    ttl_sec: int
    model_tag: str = ""


# Sessions en RAM (nettoyées par unload ou TTL à la lecture).
_sessions: dict[str, EphemeralShardSession] = {}
_loaded_chunks: dict[tuple[str, int, int], bytes] = {}


def _now_ns() -> int:
    return time.time_ns()


def shard_init(session_id: str, ttl_sec: int, layer_start: int, layer_end: int, model_tag: str) -> str:
    _purge_expired()
    _sessions[session_id] = EphemeralShardSession(
        session_id=session_id,
        layer_start=layer_start,
        layer_end=layer_end,
        created_ns=_now_ns(),
        ttl_sec=max(1, min(ttl_sec, 3600)),
        model_tag=model_tag or "",
    )
    return f"ok init {session_id} layers {layer_start}-{layer_end} model={model_tag or 'default'}"


def shard_load_chunk(session_id: str, chunk_index: int, chunk_total: int, payload: bytes) -> str:
    _purge_expired()
    if session_id not in _sessions:
        return f"err unknown_session {session_id}"
    key = (session_id, chunk_index, chunk_total)
    _loaded_chunks[key] = bytes(payload)
    return f"ok load {session_id} chunk {chunk_index + 1}/{chunk_total} ({len(payload)} B)"


def shard_unload(session_id: str) -> str:
    keys = [k for k in _loaded_chunks if k[0] == session_id]
    for k in keys:
        del _loaded_chunks[k]
    _sessions.pop(session_id, None)
    return f"ok unload {session_id}"


def _assemble_tp_weights(session_id: str) -> bytes | None:
    keys = [k for k in _loaded_chunks if k[0] == session_id]
    if not keys:
        return None
    chunk_total = keys[0][2]
    by_idx: dict[int, bytes] = {}
    for k in keys:
        if k[2] != chunk_total:
            continue
        by_idx[k[1]] = _loaded_chunks[k]
    if len(by_idx) < chunk_total:
        return None
    return b"".join(by_idx[i] for i in range(chunk_total))


def real_dist_forward(activation: bytes, layer_id: int, session_id: str) -> bytes:
    """Forward pipeline distribué : npz avec W,b ; optionnel E (h,256) ; optionnel W_out,b_out logits."""
    bundle = _assemble_tp_weights(session_id)
    if bundle is None:
        raise ValueError("poids vryx.dist manquants ou chunks incomplets")
    wdict = np.load(io.BytesIO(bundle), allow_pickle=False)
    W = np.asarray(wdict["W"], dtype=np.float32)
    b = np.asarray(wdict["b"], dtype=np.float32)
    in_dim = int(W.shape[1])
    E = wdict["E"] if "E" in wdict.files else None
    if E is not None:
        E = np.asarray(E, dtype=np.float32)
    W_out = wdict["W_out"] if "W_out" in wdict.files else None
    b_out = wdict["b_out"] if "b_out" in wdict.files else None
    if W_out is not None:
        W_out = np.asarray(W_out, dtype=np.float32)
    if b_out is not None:
        b_out = np.asarray(b_out, dtype=np.float32)

    if len(activation) == 4:
        tid = int(np.frombuffer(activation, dtype=np.uint32)[0]) % 256
        if E is None:
            raise ValueError("activation token 4 octets sans table E sur ce shard")
        x = np.ascontiguousarray(E[:, tid], dtype=np.float32)
    else:
        x = np.frombuffer(activation, dtype=np.float32).copy()
        if x.size != in_dim:
            if x.size > in_dim:
                x = x[:in_dim].copy()
            else:
                x = np.pad(x, (0, in_dim - x.size))

    _ = layer_id
    y = (np.matmul(W, x) + b).astype(np.float32, copy=False)
    y = np.maximum(0.0, y).astype(np.float32)
    if W_out is not None and b_out is not None:
        logits = (np.matmul(W_out, y) + b_out).astype(np.float32, copy=False)
        return np.asarray(logits, dtype=np.float32).tobytes()
    return y.tobytes()


def real_tp_forward(activation: bytes, layer_id: int, session_id: str) -> bytes:
    """Forward réel : npz (W, b) en float32, ReLU(W @ x + b)."""
    bundle = _assemble_tp_weights(session_id)
    if bundle is None:
        raise ValueError("poids TP manquants ou chunks incomplets")
    wdict = np.load(io.BytesIO(bundle), allow_pickle=False)
    W = np.asarray(wdict["W"], dtype=np.float32)
    b = np.asarray(wdict["b"], dtype=np.float32)
    x = np.frombuffer(activation, dtype=np.float32)
    if W.ndim != 2:
        raise ValueError("W doit être une matrice 2D")
    in_dim = W.shape[1]
    if x.size != in_dim:
        if x.size > in_dim:
            x = x[:in_dim].copy()
        else:
            x = np.pad(x, (0, in_dim - x.size))
    _ = layer_id  # réservé pour empilement multi-couches
    y = x @ W.T + b
    y = np.maximum(0.0, y).astype(np.float32)
    return y.tobytes()


def ephemeral_layer_forward(activation: bytes, layer_id: int, session_id: str) -> bytes:
    """Forward XOR (sessions non-TP) ou numpy (sessions `vryx.tp` / `vryx.dist`)."""
    _purge_expired()
    sess = _sessions.get(session_id)
    if sess and (sess.model_tag == "vryx.dist" or sess.model_tag.startswith("vryx.dist")):
        return real_dist_forward(activation, layer_id, session_id)
    if sess and (sess.model_tag == "vryx.tp" or sess.model_tag.startswith("vryx.tp")):
        return real_tp_forward(activation, layer_id, session_id)
    h = hashlib.sha256()
    h.update(session_id.encode("utf-8", errors="replace"))
    h.update(struct.pack("<I", layer_id))
    h.update(activation)
    digest = h.digest()
    if len(activation) == 0:
        return digest
    out = bytearray(len(activation))
    for i, b in enumerate(activation):
        out[i] = b ^ digest[i % len(digest)]
    return bytes(out)


def _purge_expired() -> None:
    now = _now_ns()

    def ttl_ns(s: EphemeralShardSession) -> int:
        return int(s.ttl_sec) * 1_000_000_000

    dead = [sid for sid, s in _sessions.items() if now - s.created_ns > ttl_ns(s)]
    for sid in dead:
        shard_unload(sid)
