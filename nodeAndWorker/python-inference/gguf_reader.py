"""
Lecture ciblée de tenseurs depuis un fichier GGUF (Gemma et familles Llama-like).

Utilise le paquet `gguf` pour lister les tenseurs et extraire des blocs en float32
pour le pipeline tensor-parallel (poids partiels, pas le modèle complet en RAM).

Variable d'environnement : VRYX_GGUF_PATH — chemin vers un fichier .gguf.
"""
from __future__ import annotations

import os

import numpy as np

try:
    import gguf  # type: ignore
except ImportError:  # pragma: no cover
    gguf = None  # type: ignore


def gguf_available() -> bool:
    return gguf is not None


def _dequantize(data: np.ndarray, qtype: int) -> np.ndarray:
    """Déquantification minimale : F32 / F16 ; autres types renvoient float32 brut si possible."""
    try:
        import gguf.quants as q  # type: ignore
    except Exception:
        q = None
    # GGML types courants (gguf-py)
    F32 = 0
    F16 = 1
    if qtype == F32:
        return data.astype(np.float32, copy=False)
    if qtype == F16:
        return data.view(np.float16).astype(np.float32)
    if q is not None and hasattr(q, "dequantize"):
        try:
            return np.asarray(q.dequantize(data, qtype), dtype=np.float32)
        except Exception:
            pass
    return np.asarray(data, dtype=np.float32)


def list_tensor_names(path: str, max_names: int = 200) -> list[str]:
    if not gguf_available() or not path or not os.path.isfile(path):
        return []
    reader = gguf.GGUFReader(path)
    names = [t.name for t in reader.tensors]
    return names[:max_names]


def read_tensor_f32(path: str, tensor_name: str) -> np.ndarray | None:
    """
    Lit un tenseur par nom exact et le convertit en float32 (1-D aplati si besoin).
    """
    if not gguf_available() or not path or not os.path.isfile(path):
        return None
    reader = gguf.GGUFReader(path)
    for tensor in reader.tensors:
        if tensor.name != tensor_name:
            continue
        raw = tensor.data
        shape = tuple(int(x) for x in tensor.shape)
        qtype = int(tensor.tensor_type)
        arr = np.asarray(raw)
        if arr.dtype == np.uint8 and qtype not in (0, 1):
            out = _dequantize(arr, qtype)
        else:
            out = arr.astype(np.float32, copy=False)
        if shape:
            try:
                out = out.reshape(shape)
            except Exception:
                out = out.reshape(-1)
        return np.ascontiguousarray(out, dtype=np.float32)
    return None


def find_ffn_down_tensor(path: str, layer_index: int) -> str | None:
    """Heuristique de nommage Gemma / Llama : blk.N.ffn_down.weight ou équivalent."""
    if not path or not os.path.isfile(path):
        return None
    names = list_tensor_names(path, 4000)
    candidates = [
        f"blk.{layer_index}.ffn_down.weight",
        f"blk.{layer_index}.feed_forward_down_proj.weight",
        f"model.layers.{layer_index}.mlp.down_proj.weight",
    ]
    for c in candidates:
        if c in names:
            return c
    prefix = f"blk.{layer_index}."
    for n in names:
        if n.startswith(prefix) and "ffn_down" in n and n.endswith(".weight"):
            return n
    return None


def load_ffn_down_slice(path: str, layer_index: int, max_rows: int = 256) -> tuple[np.ndarray, str] | None:
    """
    Charge une tranche rectangulaire (max_rows × d_model) de la matrice ffn_down si trouvée.
    Réduit la taille pour l'envoi réseau ; utile pour une vraie couche linéaire distribuée.
    """
    tname = find_ffn_down_tensor(path, layer_index)
    if not tname:
        return None
    w = read_tensor_f32(path, tname)
    if w is None or w.ndim < 2:
        return None
    # (out_features, in_features) classique
    rows = min(max_rows, w.shape[0])
    sl = w[:rows, :].copy()
    return sl, tname


def synthetic_linear_weights(hidden: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Poids déterministes pour démo sans fichier GGUF."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((hidden, hidden), dtype=np.float32) * (1.0 / np.sqrt(hidden))
    b = rng.standard_normal((hidden,), dtype=np.float32) * 0.01
    return w, b
