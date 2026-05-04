"""
Runtime shard éphémère (RAM uniquement, aucune persistance disque).

Pas de poids de modèle complet sur les postes workers : ce module applique
une transformation déterministe contrôlable sur les activations, utilisée pour
valider le pipeline tensor-parallèle et mesurer latence / débit avant branchement
sur un moteur PyTorch complet.
"""
from __future__ import annotations

import hashlib
import struct
import time
from dataclasses import dataclass


@dataclass
class EphemeralShardSession:
    session_id: str
    layer_start: int
    layer_end: int
    created_ns: int
    ttl_sec: int


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


def ephemeral_layer_forward(activation: bytes, layer_id: int, session_id: str) -> bytes:
    """Forward contrôlable : sortie déterministe sans charger Gemma localement."""
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
    ttl_ns = lambda s: int(s.ttl_sec) * 1_000_000_000
    dead = [sid for sid, s in _sessions.items() if now - s.created_ns > ttl_ns(s)]
    for sid in dead:
        shard_unload(sid)
