"""Quantification statique prototype pour poids residents Velocity."""
from __future__ import annotations

from typing import Any

import numpy as np


def quantize_q4_k_m(arr: np.ndarray, group_size: int = 32) -> dict[str, Any]:
    flat = np.asarray(arr, dtype=np.float32).reshape(-1)
    original_len = int(flat.size)
    pad = (-original_len) % group_size
    if pad:
        flat = np.pad(flat, (0, pad), mode="constant")
    groups = flat.reshape(-1, group_size)
    scales = np.maximum(np.max(np.abs(groups), axis=1) / 7.0, 1e-8).astype(np.float16)
    q = np.clip(np.round(groups / scales[:, None]), -7, 7).astype(np.int8).reshape(-1)
    if q.size % 2:
        q = np.pad(q, (0, 1), mode="constant")
    nibbles = (q.astype(np.int16) + 8).astype(np.uint8)
    packed = (nibbles[0::2] & 0x0F) | ((nibbles[1::2] & 0x0F) << 4)
    return {
        "format": "q4_k_m",
        "shape": list(arr.shape),
        "group_size": group_size,
        "original_len": original_len,
        "packed": packed,
        "scales": scales,
    }


def dequantize_q4_k_m(payload: dict[str, Any]) -> np.ndarray:
    packed = np.asarray(payload["packed"], dtype=np.uint8)
    scales = np.asarray(payload["scales"], dtype=np.float16).astype(np.float32)
    group_size = int(payload["group_size"])
    original_len = int(payload["original_len"])
    lo = (packed & 0x0F).astype(np.int8) - 8
    hi = ((packed >> 4) & 0x0F).astype(np.int8) - 8
    q = np.empty(packed.size * 2, dtype=np.int8)
    q[0::2] = lo
    q[1::2] = hi
    q = q[: scales.size * group_size].reshape(scales.size, group_size)
    out = (q.astype(np.float32) * scales[:, None]).reshape(-1)[:original_len]
    return out.reshape(tuple(payload["shape"])).astype(np.float16)
