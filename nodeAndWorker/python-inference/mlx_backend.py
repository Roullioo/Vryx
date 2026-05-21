"""
Backend Velocity MLX pour workers Apple Silicon — Qwen2 / Qwen3.5.

Activation :
    VRYX_ENABLE_MLX_RUNTIME=1
    VRYX_ENABLE_MLX_KERNELS=1

Si MLX n'est pas installé ou si les flags sont absents, le backend
retourne à PyTorch transparentement (fallback via _select_backend).
"""
from __future__ import annotations

import base64
import gc
import json
import os
import resource
import time
from typing import Any

import numpy as np

try:
    from mlx_state_pages import StatePageAllocator
except Exception:
    StatePageAllocator = None


_STATE_ALLOCATOR = StatePageAllocator(max_sessions=int(os.environ.get("VRYX_MLX_STATE_MAX_SESSIONS", "32"))) if StatePageAllocator else None

_SCAN_BACKEND_ENV = "VRYX_MLX_SCAN_BACKEND"
_SCAN_BACKENDS = {"python", "chunked", "metal"}


def _rss_mb() -> float:
    """RSS approximatif du process courant, en MB."""
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS retourne des octets, Linux des KB.
    return float(usage / (1024 * 1024) if usage > 10_000_000 else usage / 1024)


def _mx_weight_dtype(mx: Any) -> Any:
    dtype = os.environ.get("VRYX_MLX_WEIGHT_DTYPE", "fp16").strip().lower()
    if dtype in ("fp32", "float32"):
        return mx.float32
    return mx.float16


def _mlx_clear_cache(mx: Any) -> None:
    gc.collect()
    try:
        mx.eval()
    except Exception:
        pass
    try:
        mx.metal.clear_cache()
    except Exception:
        pass


def _normalize_scan_backend(value: str | None) -> str:
    backend = (value or "chunked").strip().lower()
    if backend not in _SCAN_BACKENDS:
        print(f"[mlx] {_SCAN_BACKEND_ENV}={backend!r} invalide, fallback chunked")
        return "chunked"
    return backend


def _strict_metal_scan() -> bool:
    return os.environ.get("VRYX_MLX_SCAN_STRICT", "0").lower() in ("1", "true", "yes")


# ── helpers numériques MLX ────────────────────────────────────────────────────

def _mx_rms_norm(mx, x: Any, weight: Any, eps: float = 1e-6) -> Any:
    return mx.fast.rms_norm(x, weight, eps)


def _mx_silu(mx, x: Any) -> Any:
    return x * mx.sigmoid(x)


def _mx_rope_freqs(mx, head_dim: int, max_len: int, theta: float = 1_000_000.0) -> tuple:
    half = head_dim // 2
    inv_freq = 1.0 / (theta ** (mx.arange(0, half, dtype=mx.float32) / half))
    t = mx.arange(max_len, dtype=mx.float32)
    freqs = mx.outer(t, inv_freq)  # [max_len, half]
    cos = mx.cos(freqs)
    sin = mx.sin(freqs)
    return cos, sin


def _mx_apply_rope(mx, q: Any, k: Any, pos_ids: Any, cos: Any, sin: Any) -> tuple:
    """Apply RoPE to q and k — both [B, num_heads, L, head_dim]."""
    half = q.shape[-1] // 2
    cos_pos = cos[pos_ids]   # [B, L, half] or [L, half]
    sin_pos = sin[pos_ids]

    def rotate(x: Any) -> Any:
        x1, x2 = x[..., :half], x[..., half:]
        # broadcast cos/sin over heads dimension
        c = mx.expand_dims(cos_pos, axis=-3) if x.ndim == 4 else cos_pos
        s = mx.expand_dims(sin_pos, axis=-3) if x.ndim == 4 else sin_pos
        return mx.concatenate([x1 * c - x2 * s, x1 * s + x2 * c], axis=-1)

    return rotate(q), rotate(k)


def _mx_sdpa(mx, q: Any, k: Any, v: Any, scale: float, mask: Any | None) -> Any:
    """Scaled dot-product attention via mlx.fast (FlashAttention-like)."""
    # mlx sdpa expects [B, H, L, D]
    return mx.fast.scaled_dot_product_attention(q, k, v, scale=scale, mask=mask)


def _mx_gqa_forward(
    mx,
    hidden: Any,
    q_w: Any, k_w: Any, v_w: Any, o_w: Any,
    q_b: Any | None, k_b: Any | None, v_b: Any | None, o_b: Any | None,
    q_norm_w: Any | None, k_norm_w: Any | None,
    rms_eps: float,
    num_heads: int, num_kv_heads: int, head_dim: int,
    pos_ids: Any,
    cos: Any, sin: Any,
    past_k: Any | None, past_v: Any | None,
    causal_mask: Any | None,
    use_cache: bool,
    linear_fn: Any | None = None,
    linear_prefixes: tuple[str, str, str, str] | None = None,
) -> tuple[Any, Any | None, Any | None]:
    B, L, _ = hidden.shape
    # Qwen3.5 full_attention: q_proj sort 2×num_heads×head_dim (gated queries: [q, gate]).
    # Llama/Mistral GQA can also have q_out/k_out as an even ratio (for example
    # Llama2 70B: 8192/1024 = 8), so ratio parity is not enough. Only enable the
    # gated path when q_proj is exactly twice the expected query width.
    k_out = int(k_w.shape[0])   # = num_kv_heads × head_dim
    q_out = int(q_w.shape[0])   # = num_heads_q × head_dim  OU  2 × num_heads_q × head_dim
    # Heuristique: si q_out = 2 × num_kv_heads × head_dim × ratio → utiliser gated
    # Pour Qwen3.5: num_kv_heads=4, head_dim=256, k_out=1024, q_out=8192=2×16×256
    # Vérifier si q_out est un multiple pair de k_out
    is_gated_q = False
    gate_q = None
    expected_q_width = int(num_heads) * int(head_dim)
    if expected_q_width > 0 and q_out == expected_q_width * 2:
        is_gated_q = True
    if k_out > 0 and q_out % k_out == 0:
        ratio = q_out // k_out
        if is_gated_q:
            # q_out = 2 × num_heads × head_dim : gated attention
            head_dim = k_out // num_kv_heads if num_kv_heads > 0 else head_dim
            num_heads = (q_out // 2) // head_dim if head_dim > 0 else num_heads
        else:
            head_dim = k_out // num_kv_heads if num_kv_heads > 0 else head_dim
            num_heads = q_out // head_dim if head_dim > 0 else num_heads

    if linear_fn is not None and linear_prefixes is not None:
        q_proj = linear_fn(hidden, linear_prefixes[0])
        k_proj = linear_fn(hidden, linear_prefixes[1])
        v_proj = linear_fn(hidden, linear_prefixes[2])
    else:
        q_proj = hidden @ q_w.T
        k_proj = hidden @ k_w.T
        v_proj = hidden @ v_w.T
        if q_b is not None:
            q_proj = q_proj + q_b
        if k_b is not None:
            k_proj = k_proj + k_b
        if v_b is not None:
            v_proj = v_proj + v_b

    q = q_proj.reshape(B, L, -1, head_dim * (2 if is_gated_q else 1)).transpose(0, 2, 1, 3)
    if is_gated_q:
        # Split en [query, gate] sur la dernière dimension
        half = head_dim
        gate_q = q[..., half:]    # [B, H, L, head_dim]
        q = q[..., :half]         # [B, H, L, head_dim]
    k = k_proj.reshape(B, L, num_kv_heads, head_dim).transpose(0, 2, 1, 3)
    v = v_proj.reshape(B, L, num_kv_heads, head_dim).transpose(0, 2, 1, 3)

    # per-head QK norm (Qwen3 feature) — seulement si size compatible
    if q_norm_w is not None and int(q_norm_w.shape[0]) == head_dim:
        q = mx.fast.rms_norm(q, q_norm_w, rms_eps)
    if k_norm_w is not None and int(k_norm_w.shape[0]) == head_dim:
        k = mx.fast.rms_norm(k, k_norm_w, rms_eps)

    q, k = _mx_apply_rope(mx, q, k, pos_ids, cos, sin)

    if past_k is not None and past_v is not None:
        k = mx.concatenate([past_k, k], axis=2)
        v = mx.concatenate([past_v, v], axis=2)

    new_k = k if use_cache else None
    new_v = v if use_cache else None

    # GQA: repeat k/v heads to match q heads
    if num_kv_heads < num_heads:
        repeats = num_heads // num_kv_heads
        k = mx.repeat(k, repeats, axis=1)
        v = mx.repeat(v, repeats, axis=1)

    scale = head_dim ** -0.5
    out = _mx_sdpa(mx, q, k, v, scale, causal_mask)  # [B, H, L, D]
    out = out.transpose(0, 2, 1, 3).reshape(B, L, num_heads * head_dim)
    if is_gated_q and gate_q is not None:
        gate = gate_q.transpose(0, 2, 1, 3).reshape(B, L, num_heads * head_dim)
        out = out * mx.sigmoid(gate)
    if linear_fn is not None and linear_prefixes is not None:
        out = linear_fn(out, linear_prefixes[3])
    else:
        out = out @ o_w.T
        if o_b is not None:
            out = out + o_b
    return out, new_k, new_v


def _mx_mlp(mx, x: Any, gate_w: Any, up_w: Any, down_w: Any) -> Any:
    # x: [B, L, D] — utiliser matmul "batch" via einsum ou reshape
    gate = x @ gate_w.T              # [B, L, intermediate]
    up = x @ up_w.T                  # [B, L, intermediate]
    return _mx_silu(mx, gate) * up @ down_w.T  # [B, L, D]


def _mx_l2norm(mx, x: Any, eps: float = 1e-6) -> Any:
    return x * mx.rsqrt(mx.sum(x * x, axis=-1, keepdims=True) + eps)


def _mx_softplus(mx, x: Any) -> Any:
    return mx.logaddexp(x, 0.0)


def _mx_sigmoid(mx, x: Any) -> Any:
    return mx.sigmoid(x)


def _causal_conv1d_mlx(mx, x_bcl: Any, weight: Any, bias: Any | None = None) -> Any:
    """Depthwise causal Conv1d vectorielle — évite la boucle Python."""
    bsz, channels, seq_len = x_bcl.shape
    weight_ck = weight.squeeze(1) if getattr(weight, "ndim", 0) == 3 else weight
    kernel = int(weight_ck.shape[-1])
    # Padder causalement à gauche (kernel-1 zéros)
    pad = mx.zeros((bsz, channels, kernel - 1), dtype=x_bcl.dtype)
    padded = mx.concatenate([pad, x_bcl], axis=2)  # [B, C, L+K-1]
    # Extraire toutes les fenêtres en une opération vectorielle
    # windows[t] = padded[:, :, t:t+kernel] → [B, C, K]
    # Empiler les K positions → [B, C, L, K]
    windows = mx.stack([padded[:, :, t:t + seq_len] for t in range(kernel)], axis=-1)  # [B, C, L, K]
    # Appliquer la convolution: sum over K avec les poids
    # weight_ck: [C, K] → weight_ck[None, :, None, :] broadcast over B and L
    out = mx.sum(windows * mx.expand_dims(mx.expand_dims(weight_ck, axis=0), axis=2), axis=-1)  # [B, C, L]
    if bias is not None:
        out = out + mx.expand_dims(mx.expand_dims(bias, axis=0), axis=2)
    return _mx_silu(mx, out)


def _gated_rms_norm(mx, hidden: Any, gate: Any, weight: Any, eps: float = 1e-6) -> Any:
    h = hidden.astype(mx.float32)
    h = h * mx.rsqrt(mx.mean(h * h, axis=-1, keepdims=True) + eps)
    return (h * weight) * _mx_silu(mx, gate.astype(mx.float32))


def _linear_attn_shapes(weights: dict[str, Any], prefix: str) -> dict[str, Any]:
    keys = [
        "in_proj_qkv.weight", "in_proj_a.weight", "in_proj_b.weight",
        "in_proj_z.weight", "out_proj.weight", "conv1d.weight",
        "dt_bias", "A_log", "norm.weight",
    ]
    return {k: tuple(weights[f"{prefix}.linear_attn.{k}"].shape) for k in keys if f"{prefix}.linear_attn.{k}" in weights}


def _debug_top_logits_mx(mx: Any, logits: Any, k: int = 10) -> list[dict[str, float | int]]:
    if os.environ.get("VRYX_DEBUG_TOP_LOGITS", "0").lower() not in ("1", "true", "yes"):
        return []
    arr = np.asarray(mx.array(logits).tolist(), dtype=np.float32).reshape(-1)
    k = max(1, min(k, int(arr.size)))
    idx = np.argpartition(-arr, k - 1)[:k]
    idx = idx[np.argsort(-arr[idx])]
    return [{"id": int(i), "logit": float(arr[i])} for i in idx]


# ── Principal ─────────────────────────────────────────────────────────────────

class MLXBackend:
    name = "mlx"

    def __init__(self, shard: Any):
        self.shard = shard
        self.unavailable_reason: str | None = None
        self.mx = None
        self.weights: dict[str, Any] = {}
        self.kv_cache: list[tuple[Any, Any]] | None = None  # per-layer (K, V)
        self.linear_states: list[dict[str, Any]] | None = None
        self.state_page = None
        self._cos: Any = None
        self._sin: Any = None
        self.scan_backend_requested = _normalize_scan_backend(os.environ.get(_SCAN_BACKEND_ENV))
        self.scan_backend_effective = self.scan_backend_requested

        runtime_requested = str(os.environ.get("VRYX_RUNTIME_BACKEND") or "").strip().lower() == "mlx"
        mlx_supported = os.environ.get("VRYX_SUPPORTS_MLX", "0").lower() in ("1", "true", "yes")
        mlx_runtime_enabled = (
            os.environ.get("VRYX_ENABLE_MLX_RUNTIME", "0").lower() in ("1", "true", "yes")
            or runtime_requested
            or mlx_supported
        )
        mlx_kernels_enabled = (
            os.environ.get("VRYX_ENABLE_MLX_KERNELS", "0").lower() in ("1", "true", "yes")
            or mlx_runtime_enabled
        )
        if not mlx_runtime_enabled:
            self.unavailable_reason = "mlx_runtime_flag_disabled"
            return
        if not mlx_kernels_enabled:
            self.unavailable_reason = "mlx_qwen_kernels_pending"
            return
        try:
            import mlx.core as mx
            self.mx = mx
        except Exception as e:
            self.unavailable_reason = f"mlx_unavailable:{e}"

    @property
    def available(self) -> bool:
        return self.mx is not None and self.unavailable_reason is None

    # ── build ─────────────────────────────────────────────────────────────────

    def build(self) -> dict[str, Any]:
        if not self.available:
            return {"ok": False, "runtime_backend": self.name,
                    "error": self.unavailable_reason or "mlx_unavailable"}
        mx = self.mx
        t0 = time.perf_counter()

        # Convertir les poids numpy → MLX sans promotion fp32.
        # Pour Qwen3.5-9B, promouvoir les shards en fp32 double la mémoire et
        # provoque des crashs/stack overflows sous pression mémoire sur Mac.
        self.weights = {}
        weight_dtype = _mx_weight_dtype(mx)
        source_bytes = int(sum(int(getattr(arr, "nbytes", 0)) for arr in self.shard.weight_arrays.values()))
        max_shard_gb = float(os.environ.get("VRYX_MLX_MAX_SHARD_GB", "32"))
        if source_bytes > max_shard_gb * 1024**3:
            return {
                "ok": False,
                "runtime_backend": self.name,
                "error": f"mlx_shard_too_large:{source_bytes / 1024**3:.2f}GB>{max_shard_gb:.2f}GB",
                "source_weight_bytes": source_bytes,
                "rss_mb": round(_rss_mb(), 1),
            }
        for name, arr in self.shard.weight_arrays.items():
            arr_np = np.asarray(arr)
            if arr_np.dtype.kind in ("u", "i", "b"):
                self.weights[name] = mx.array(arr_np)
            else:
                self.weights[name] = mx.array(arr_np, dtype=weight_dtype)
        # Forcer le chargement GPU Metal
        mx.eval(*self.weights.values())

        self.shard.weights_loaded = len(self.weights)
        # Les poids MLX sont résidents ; libérer immédiatement les vues/memmaps
        # côté Python pour éviter une double résidence pendant le forward.
        self.shard.weight_arrays.clear()
        _mlx_clear_cache(mx)
        self.shard.build_ms = int((time.perf_counter() - t0) * 1000)
        print(
            f"[mlx] build {self.shard.session_id[:16]}… weights={len(self.weights)} "
            f"dtype={weight_dtype} source={source_bytes / 1024**3:.2f}GB rss={_rss_mb():.1f}MB "
            f"sample_keys={list(self.weights)[:12]}"
        )
        linear_shapes = self._probe_linear_attn_shapes()
        self.linear_states = [{} for _ in range(max(0, self.shard.layer_end - self.shard.layer_start + 1))]
        if _STATE_ALLOCATOR is not None:
            self.state_page = _STATE_ALLOCATOR.acquire(self.shard.session_id)

        # Pré-calculer les fréquences RoPE
        cfg = self.shard.model_config
        head_dim = cfg.get("head_dim") or (
            cfg.get("hidden_size", 4096) // cfg.get("num_attention_heads", 32)
        )
        theta = float(cfg.get("rope_theta", 1_000_000.0))
        max_len = int(cfg.get("max_position_embeddings", 32768))
        self._cos, self._sin = _mx_rope_freqs(mx, head_dim, max_len, theta)
        mx.eval(self._cos, self._sin)

        return {
            "ok": True,
            "runtime_backend": self.name,
            "params": len(self.weights),
            "build_ms": self.shard.build_ms,
            "attention_backend": "mlx_metal",
            "kernel_status": "active",
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "linear_attn_ready": bool(linear_shapes),
            "linear_attn_shapes": linear_shapes,
            "state_pages": _STATE_ALLOCATOR.status() if _STATE_ALLOCATOR is not None else None,
            "source_weight_bytes": source_bytes,
            "weight_dtype": str(weight_dtype),
            "rss_mb": round(_rss_mb(), 1),
        }

    def _quant_cfg(self, prefix: str) -> dict[str, Any]:
        q = self.shard.model_config.get("quantization")
        if not isinstance(q, dict):
            return {"group_size": 64, "bits": 4, "mode": "affine"}
        cfg = {
            "group_size": int(q.get("group_size") or 64),
            "bits": int(q.get("bits") or 4),
            "mode": str(q.get("mode") or "affine"),
        }
        candidates = [prefix]
        if prefix.startswith("layers."):
            parts = prefix.split(".", 2)
            if len(parts) == 3 and parts[1].isdigit():
                global_i = self.shard.layer_start + int(parts[1])
                candidates.append(f"language_model.model.layers.{global_i}.{parts[2]}")
                candidates.append(f"model.layers.{global_i}.{parts[2]}")
        elif prefix in ("embed_tokens", "lm_head"):
            candidates.extend([
                f"language_model.model.{prefix}",
                f"language_model.{prefix}",
                f"model.{prefix}",
            ])
        for key in candidates:
            item = q.get(key)
            if isinstance(item, dict):
                cfg["group_size"] = int(item.get("group_size") or cfg["group_size"])
                cfg["bits"] = int(item.get("bits") or cfg["bits"])
                cfg["mode"] = str(item.get("mode") or cfg["mode"])
                break
        return cfg

    def _linear_out_features(self, prefix: str) -> int:
        w = self._w(f"{prefix}.weight")
        if w is None:
            return 0
        return int(w.shape[-2] if getattr(w, "ndim", 0) >= 3 else w.shape[0])

    def _linear_in_features(self, prefix: str) -> int:
        w = self._w(f"{prefix}.weight")
        if w is None:
            return 0
        scales = self.weights.get(f"{prefix}.scales")
        if scales is not None:
            cfg = self._quant_cfg(prefix)
            return int(w.shape[-1]) * 32 // max(1, int(cfg.get("bits") or 4))
        return int(w.shape[-1])

    def _linear(self, x: Any, prefix: str, expert_idx: int | None = None) -> Any:
        mx = self.mx
        w = self._w(f"{prefix}.weight")
        if w is None:
            raise ValueError(f"linear_weight_missing:{prefix}.weight")
        scales = self.weights.get(f"{prefix}.scales")
        biases = self.weights.get(f"{prefix}.biases")
        dense_bias = self.weights.get(f"{prefix}.bias")
        if expert_idx is not None and getattr(w, "ndim", 0) >= 3:
            w = w[expert_idx]
            if scales is not None and getattr(scales, "ndim", 0) >= 3:
                scales = scales[expert_idx]
            if biases is not None and getattr(biases, "ndim", 0) >= 3:
                biases = biases[expert_idx]
            if dense_bias is not None and getattr(dense_bias, "ndim", 0) >= 2:
                dense_bias = dense_bias[expert_idx]
        if scales is not None:
            cfg = self._quant_cfg(prefix)
            y = mx.quantized_matmul(
                x,
                w,
                scales=scales,
                biases=biases,
                transpose=True,
                group_size=int(cfg.get("group_size") or 64),
                bits=int(cfg.get("bits") or 4),
                mode=str(cfg.get("mode") or "affine"),
            )
        else:
            y = x @ w.T
        if dense_bias is not None:
            y = y + dense_bias
        return y

    def _embedding_lookup(self, mx: Any, token_ids: Any) -> Any:
        emb = self.weights.get("embed_tokens.weight")
        if emb is None:
            raise ValueError("embed_tokens.weight manquant")
        scales = self.weights.get("embed_tokens.scales")
        if scales is not None:
            cfg = self._quant_cfg("embed_tokens")
            emb = mx.dequantize(
                emb,
                scales=scales,
                biases=self.weights.get("embed_tokens.biases"),
                group_size=int(cfg.get("group_size") or 64),
                bits=int(cfg.get("bits") or 4),
                mode=str(cfg.get("mode") or "affine"),
                dtype=mx.float16,
            )
            mx.eval(emb)
            self.weights["embed_tokens.weight"] = emb
            self.weights.pop("embed_tokens.scales", None)
            self.weights.pop("embed_tokens.biases", None)
        return emb[token_ids]

    def _moe_mlp(self, mx: Any, prefix: str, x: Any) -> Any:
        gate_prefix = f"{prefix}.mlp.gate"
        switch_prefix = f"{prefix}.mlp.switch_mlp"
        shared_prefix = f"{prefix}.mlp.shared_expert"
        flat = x.reshape(-1, int(x.shape[-1]))
        logits = self._linear(flat, gate_prefix).astype(mx.float32)
        top_k = max(1, min(int(self.shard.model_config.get("num_experts_per_tok") or 8), int(logits.shape[-1])))
        probs = mx.softmax(logits, axis=-1)
        idxs = mx.argsort(probs, axis=-1)[:, -top_k:]
        vals = mx.take_along_axis(probs, idxs, axis=-1)
        vals = vals / mx.sum(vals, axis=-1, keepdims=True)
        mx.eval(vals, idxs)
        idx_np = np.asarray(idxs, dtype=np.int64)
        vals_np = np.asarray(vals, dtype=np.float32)
        rows = []
        for token_i in range(idx_np.shape[0]):
            token = flat[token_i:token_i + 1]
            acc = None
            for pos in range(idx_np.shape[1]):
                expert_idx = int(idx_np[token_i, pos])
                gate_up = self._linear(token, f"{switch_prefix}.gate_proj", expert_idx=expert_idx)
                up = self._linear(token, f"{switch_prefix}.up_proj", expert_idx=expert_idx)
                down = self._linear(_mx_silu(mx, gate_up) * up, f"{switch_prefix}.down_proj", expert_idx=expert_idx)
                contrib = down * float(vals_np[token_i, pos])
                acc = contrib if acc is None else acc + contrib
            if f"{shared_prefix}.gate_proj.weight" in self.weights:
                shared = self._linear(_mx_silu(mx, self._linear(token, f"{shared_prefix}.gate_proj")) * self._linear(token, f"{shared_prefix}.up_proj"), f"{shared_prefix}.down_proj")
                shared_gate = mx.sigmoid(self._linear(token, f"{prefix}.mlp.shared_expert_gate"))
                acc = (acc if acc is not None else mx.zeros_like(shared)) + shared_gate * shared
            rows.append(acc[0])
        return mx.stack(rows, axis=0).reshape(x.shape)

    def _dense_mlp(self, mx: Any, prefix: str, x: Any) -> Any:
        gate = self._linear(x, f"{prefix}.mlp.gate_proj")
        up = self._linear(x, f"{prefix}.mlp.up_proj")
        return self._linear(_mx_silu(mx, gate) * up, f"{prefix}.mlp.down_proj")

    # ── forward ───────────────────────────────────────────────────────────────

    def forward(self, data: bytes, session_id: str) -> bytes:
        if not self.available:
            raise RuntimeError(self.unavailable_reason or "mlx_unavailable")
        mx = self.mx

        t0 = time.perf_counter()
        try:
            payload = json.loads(data.decode("utf-8", errors="replace"))
        except Exception:
            return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

        sid = payload.get("session_id", session_id) or session_id
        request_id = str(payload.get("request_id") or "default")
        step = int(payload.get("step", 0))
        seq_pos = int(payload.get("seq_pos", 0))
        use_kv = bool(payload.get("use_kv_cache", True))
        requested_decode_mode = str(payload.get("decode_mode") or ("prefill_full_context" if step == 0 else "full_context_fallback"))
        stateful_required = bool(payload.get("stateful_required") or requested_decode_mode == "single_token_stateful")
        if not hasattr(self, "_request_states"):
            self._request_states: dict[str, dict[str, Any]] = {}
        if request_id != "default":
            saved_state = self._request_states.get(request_id) or {}
            self.kv_cache = saved_state.get("kv_cache")
            if "linear_states" in saved_state:
                self.linear_states = saved_state.get("linear_states")
        print(
            f"[mlx] forward-start sid={sid[:16]} step={step} "
            f"embed={self.shard.has_embedding} head={self.shard.has_lm_head} "
            f"token_ids={'token_ids' in payload} hidden={any(k in payload for k in ('hidden_q_b64', 'hidden_q4_b64', 'hidden_fp16_b64', 'hidden_b64'))} "
            f"keys={sorted(payload.keys())}"
        )

        cfg = self.shard.model_config
        hidden_size = int(cfg.get("hidden_size", 4096))
        num_heads = int(cfg.get("num_attention_heads", 32))
        num_kv_heads = int(cfg.get("num_key_value_heads", num_heads))
        head_dim = cfg.get("head_dim") or (hidden_size // num_heads)
        rms_eps = float(cfg.get("rms_norm_eps", 1e-6))
        vocab_size = int(cfg.get("vocab_size", 152064))

        HIDDEN_TRANSPORT = os.environ.get("VRYX_HIDDEN_TRANSPORT", "int8")

        # Reset KV cache à chaque step 0
        if step == 0:
            self.kv_cache = None
            if request_id != "default":
                self.linear_states = [{} for _ in range(max(0, self.shard.layer_end - self.shard.layer_start + 1))]
                self._request_states.pop(request_id, None)

        # ── Obtenir hidden_states ────────────────────────────────────────────
        if self.shard.has_embedding and "token_ids" in payload:
            token_ids = payload["token_ids"]
            ids_mx = mx.array(token_ids, dtype=mx.int32)
            try:
                hidden = self._embedding_lookup(mx, ids_mx)  # [L, D]
            except Exception as exc:
                return json.dumps({"ok": False, "error": str(exc)}).encode()
            hidden = mx.expand_dims(hidden, axis=0)  # [1, L, D]
            seq_len = len(token_ids)
        else:
            hidden = self._decode_hidden(payload, hidden_size)
            if hidden is None:
                return json.dumps({"ok": False, "error": "hidden state manquant"}).encode()
            if hidden.ndim == 2:
                hidden = mx.expand_dims(hidden, axis=0)
            seq_len = int(hidden.shape[1])

        hidden = hidden.astype(mx.float32)
        B = int(hidden.shape[0])
        if step > 0 and use_kv and requested_decode_mode == "single_token_stateful" and seq_len != 1:
            return json.dumps({
                "ok": False,
                "error": f"decode stateful invalide : seq_len={seq_len}, attendu=1",
                "session_id": sid,
                "step": step,
                "seq_pos": seq_pos,
                "decode_mode": "full_context_fallback",
            }).encode()
        if step > 0 and stateful_required and use_kv and self.kv_cache is None:
            return json.dumps({
                "ok": False,
                "error": "KV cache stateful MLX manquant : refus du full prefill fallback",
                "session_id": sid,
                "step": step,
                "seq_pos": seq_pos,
                "decode_mode": "single_token_stateful",
                "kv_cache": False,
                "runtime_backend": "mlx",
            }).encode()
        decode_mode = (
            "prefill_full_context"
            if step == 0
            else ("single_token_stateful" if use_kv and seq_len == 1 else "full_context_fallback")
        )
        self.shard.last_decode_mode = decode_mode

        out_seq_pos = seq_pos

        def mlx_run_transformer(hidden_in: Any, seq_pos_run: int, seq_len_run: int, causal_here: Any) -> Any | None:
            """Passe Transformer (attention + MLP) ; met à jour kv_cache et shard.seq_position."""
            pos_ids_here = mx.arange(seq_pos_run, seq_pos_run + seq_len_run, dtype=mx.int32)
            h = hidden_in.astype(mx.float32)
            n_layers_here = self.shard.layer_end - self.shard.layer_start + 1
            if self.kv_cache is None:
                self.kv_cache = [None] * n_layers_here  # type: ignore[assignment]
            n_heads_here = num_heads
            head_dim_here = head_dim  # évite de muter outer scope définitivement
            num_kv_heads_here = num_kv_heads
            eval_every = max(1, int(os.environ.get("VRYX_MLX_EVAL_EVERY_LAYERS", "1")))
            progress_every = max(0, int(os.environ.get("VRYX_MLX_PROGRESS_EVERY_LAYERS", "4")))
            for local_i in range(n_layers_here):
                prefix = f"layers.{local_i}"
                layer_t0 = time.perf_counter()
                norm1_w = self._w(f"{prefix}.input_layernorm.weight")
                norm2_w = self._w(f"{prefix}.post_attention_layernorm.weight")
                gate_w = self._w(f"{prefix}.mlp.gate_proj.weight")
                up_w = self._w(f"{prefix}.mlp.up_proj.weight")
                down_w = self._w(f"{prefix}.mlp.down_proj.weight")
                has_dense_mlp = all(w is not None for w in [gate_w, up_w, down_w])
                has_moe_mlp = f"{prefix}.mlp.gate.weight" in self.weights and f"{prefix}.mlp.switch_mlp.gate_proj.weight" in self.weights
                if norm1_w is None or norm2_w is None or (not has_dense_mlp and not has_moe_mlp):
                    return None
                normed = _mx_rms_norm(mx, h, norm1_w, rms_eps)
                if self._has_linear_attn(prefix):
                    try:
                        attn_out, _state_meta = self._linear_attn_forward(mx, prefix, local_i, normed, use_kv, rms_eps)
                    except Exception as exc:
                        import traceback
                        print(f"[mlx] linear_attn error layer {local_i}: {exc}\n{traceback.format_exc()}")
                        return None
                else:
                    q_w = self._w(f"{prefix}.self_attn.q_proj.weight")
                    k_w = self._w(f"{prefix}.self_attn.k_proj.weight")
                    v_w = self._w(f"{prefix}.self_attn.v_proj.weight")
                    o_w = self._w(f"{prefix}.self_attn.o_proj.weight")
                    q_b = self.weights.get(f"{prefix}.self_attn.q_proj.bias")
                    k_b = self.weights.get(f"{prefix}.self_attn.k_proj.bias")
                    v_b = self.weights.get(f"{prefix}.self_attn.v_proj.bias")
                    o_b = self.weights.get(f"{prefix}.self_attn.o_proj.bias")
                    q_norm_w = self.weights.get(f"{prefix}.self_attn.q_norm.weight")
                    k_norm_w = self.weights.get(f"{prefix}.self_attn.k_norm.weight")
                    if any(w is None for w in [q_w, k_w, v_w, o_w]):
                        return None
                    q_w_heads_l = int(q_w.shape[0])
                    inferred_head_dim_l = head_dim_here or (hidden_size // n_heads_here)
                    if q_w_heads_l != n_heads_here * inferred_head_dim_l:
                        inferred_head_dim_l = hidden_size // n_heads_here if hidden_size % n_heads_here == 0 else inferred_head_dim_l
                        for candidate_heads in [n_heads_here, n_heads_here * 2, n_heads_here // 2]:
                            if candidate_heads > 0 and q_w_heads_l % candidate_heads == 0:
                                inferred_num_heads = candidate_heads
                                inferred_head_dim_l = q_w_heads_l // inferred_num_heads
                                kv_out = int(k_w.shape[0])
                                if kv_out % inferred_head_dim_l == 0:
                                    n_heads_here = inferred_num_heads
                                    num_kv_heads_here = kv_out // inferred_head_dim_l
                                    head_dim_here = inferred_head_dim_l
                                    break
                    past_kv = self.kv_cache[local_i] if use_kv and self.kv_cache else None  # type: ignore[index]
                    past_k, past_v = (past_kv if past_kv is not None else (None, None))
                    o_in_l = self._linear_in_features(f"{prefix}.self_attn.o_proj")
                    layer_num_heads = n_heads_here
                    layer_head_dim = o_in_l // layer_num_heads if o_in_l % layer_num_heads == 0 else head_dim_here
                    layer_num_kv = int(k_w.shape[0]) // layer_head_dim
                    layer_cos, layer_sin = self._get_rope(mx, layer_head_dim, cfg)
                    attn_out, new_k, new_v = _mx_gqa_forward(
                        mx, normed, q_w, k_w, v_w, o_w, q_b, k_b, v_b, o_b, q_norm_w, k_norm_w, rms_eps,
                        layer_num_heads, layer_num_kv, layer_head_dim, pos_ids_here,
                        layer_cos, layer_sin, past_k, past_v, causal_here, use_kv,
                        self._linear,
                        (
                            f"{prefix}.self_attn.q_proj",
                            f"{prefix}.self_attn.k_proj",
                            f"{prefix}.self_attn.v_proj",
                            f"{prefix}.self_attn.o_proj",
                        ),
                    )
                    if use_kv and new_k is not None:
                        self.kv_cache[local_i] = (new_k, new_v)  # type: ignore[index]
                h = h + attn_out
                normed2 = _mx_rms_norm(mx, h, norm2_w, rms_eps)
                if has_moe_mlp:
                    h = h + self._moe_mlp(mx, prefix, normed2)
                else:
                    h = h + self._dense_mlp(mx, prefix, normed2)
                if eval_every and ((local_i + 1) % eval_every == 0 or local_i + 1 == n_layers_here):
                    mx.eval(h)
                if progress_every and ((local_i + 1) % progress_every == 0 or local_i + 1 == n_layers_here):
                    print(
                        f"[mlx] layer {local_i + 1}/{n_layers_here} "
                        f"sid={sid[:12]} ms={int((time.perf_counter() - layer_t0) * 1000)} "
                        f"shape={tuple(h.shape)}"
                    )

            mx.eval(h)
            self.shard.seq_position = seq_pos_run + seq_len_run
            return h

        # Masque causal (pas nécessaire pour decode seq_len=1, utile pour prefill)
        causal_mask = None
        if seq_len > 1:
            mask = mx.tril(mx.ones((seq_len, seq_len), dtype=mx.bool_))
            causal_mask = mx.where(mask, 0.0, float("-inf")).astype(mx.float32)
            causal_mask = mx.expand_dims(causal_mask, axis=(0, 1))

        hx = mlx_run_transformer(hidden, seq_pos, seq_len, causal_mask)
        if hx is None:
            return json.dumps({
                "ok": False,
                "error": "mlx_run_transformer a échoué (voir logs linear_attn)",
                "session_id": sid,
                "decode_mode": decode_mode,
                "runtime_backend": "mlx",
            }).encode()
        hidden = hx
        compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
        self.shard.last_forward_ms = compute_ms

        # ── Sortie ────────────────────────────────────────────────────────────
        if self.shard.has_lm_head:
            norm_w = self._w("norm.weight")
            lm_w = self._w("lm_head.weight")
            if norm_w is None or lm_w is None:
                return json.dumps({"ok": False, "error": "norm.weight/lm_head.weight manquant"}).encode()
            lm_head_t0 = time.perf_counter()
            last = hidden[0, -1, :]
            last_normed = _mx_rms_norm(mx, last, norm_w, rms_eps)
            logits = self._linear(last_normed, "lm_head").astype(mx.float32)
            mx.eval(logits)
            lm_head_ms = max(0, int((time.perf_counter() - lm_head_t0) * 1000))

            sampling_t0 = time.perf_counter()
            next_token_id, sampling_info = self._sample(mx, logits, payload)
            sampling_ms = max(0, int((time.perf_counter() - sampling_t0) * 1000))
            sampling_info["sampling_ms"] = sampling_ms

            samp_d = payload.get("sampling") if isinstance(payload.get("sampling"), dict) else {}
            temp_px = float(samp_d.get("temperature", float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0.35"))))
            micro_decode_requested = payload.get("micro_decode_budget")
            try:
                mb_req = max(1, int(micro_decode_requested or 1))
            except (TypeError, ValueError):
                mb_req = 1
            try:
                cap_mx = max(2, min(64, int(os.environ.get("VRYX_DECODE_MICROBATCH_CAP", "32"))))
            except (TypeError, ValueError):
                cap_mx = 32
            mb_req = max(1, min(mb_req, cap_mx))

            candidate_tokens = [next_token_id]
            hist_for_sample = []
            hp0 = payload.get("history_token_ids")
            if isinstance(hp0, list):
                hist_for_sample.extend(int(t) for t in hp0 if isinstance(t, (int, float)))
            greedy_ok_micro = temp_px <= 0.0
            want_micro_extra = (
                greedy_ok_micro
                and mb_req > 1
                and int(step) > 0
                and bool(use_kv)
                and decode_mode == "single_token_stateful"
                and self.shard.has_embedding
                and isinstance(payload.get("token_ids"), list)
                and len(payload.get("token_ids") or []) == 1
            )
            stop_ids_raw = payload.get("stop_token_ids") or []
            stop_ids_int = {int(s) for s in stop_ids_raw if isinstance(s, (int, float)) or (isinstance(s, str) and s.isdigit())}
            eos_ev = getattr(cfg, "eos_token_id", None)
            emb_w_mic = self.weights.get("embed_tokens.weight")

            if want_micro_extra and mb_req > 1 and emb_w_mic is not None:
                hist_tail = hist_for_sample
                cur_tid = next_token_id
                for _mic in range(1, mb_req):
                    if eos_ev is not None and int(cur_tid) == int(eos_ev):
                        break
                    if int(cur_tid) in stop_ids_int:
                        break
                    ids_mx_mic = mx.array([int(cur_tid)], dtype=mx.int32)
                    h_mic = mx.expand_dims(self._embedding_lookup(mx, ids_mx_mic), axis=0).astype(mx.float32)
                    sp_mic = int(self.shard.seq_position)
                    hz_mic = mlx_run_transformer(h_mic, sp_mic, 1, None)
                    if hz_mic is None:
                        break
                    hidden = hz_mic
                    lh_t = time.perf_counter()
                    last_m = hz_mic[0, -1, :]
                    ln_m = _mx_rms_norm(mx, last_m, norm_w, rms_eps)
                    logits_m = self._linear(ln_m, "lm_head").astype(mx.float32)
                    mx.eval(logits_m)
                    lm_head_ms += max(0, int((time.perf_counter() - lh_t) * 1000))
                    mic_payload = dict(payload)
                    mic_payload["micro_decode_budget"] = 1
                    tail2 = [*hist_tail, int(cur_tid)]
                    mic_payload["history_token_ids"] = tail2
                    st_mic = time.perf_counter()
                    cur_tid, s2 = self._sample(mx, logits_m, mic_payload)
                    sampling_ms += max(0, int((time.perf_counter() - st_mic) * 1000))
                    candidate_tokens.append(int(cur_tid))
                    hist_tail = tail2
                sampling_info["decode_micro_extra"] = max(0, len(candidate_tokens) - 1)
            else:
                sampling_info["decode_micro_extra"] = 0

            compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
            self.shard.last_forward_ms = compute_ms

            if request_id != "default":
                self._request_states[request_id] = {
                    "kv_cache": self.kv_cache,
                    "linear_states": self.linear_states,
                }

            n_acc = len(candidate_tokens)
            print(
                f"[mlx] lm_head {sid[:12]}… step={step} greedy_micro={want_micro_extra} "
                f"tokens_batch={n_acc} total_ms≈{compute_ms} first_tok={next_token_id}",
            )
            return json.dumps({
                "ok": True,
                "next_token_id": candidate_tokens[-1],
                "candidate_token_ids": candidate_tokens,
                "accepted_token_count": n_acc,
                "decode_microbatch": n_acc > 1,
                "speculative_method": "mlx_local_micro_greedy" if n_acc > 1 else "none",
                "speculative_available": n_acc > 1,
                "verify_ms": 0,
                "sampling": sampling_info,
                "session_id": sid,
                "request_id": request_id,
                "compute_time_ms": compute_ms,
                "lm_head_ms": lm_head_ms,
                "sampling_ms": sampling_ms,
                "kv_cache": use_kv,
                "decode_mode": decode_mode,
                "attention_backend": "mlx_metal",
                "linear_scan_backend": self.scan_backend_effective,
                "runtime_backend": "mlx",
                "debug_top_logits": _debug_top_logits_mx(mx, logits),
            }).encode()
        else:
            if request_id != "default":
                self._request_states[request_id] = {
                    "kv_cache": self.kv_cache,
                    "linear_states": self.linear_states,
                }
            transport = str(payload.get("hidden_transport", HIDDEN_TRANSPORT)).lower()
            encode_t0 = time.perf_counter()
            hidden_payload, hidden_metrics = self._encode_hidden_payload(mx, hidden, transport)
            hidden_encode_ms = max(0, int((time.perf_counter() - encode_t0) * 1000))
            hidden_metrics["hidden_encode_ms"] = hidden_encode_ms

            print(f"[mlx] forward {sid[:12]}… step={step} seq_pos={out_seq_pos} ({compute_ms}ms)")
            out = {
                "ok": True,
                "seq_pos": out_seq_pos,
                "step": step,
                "session_id": sid,
                "request_id": request_id,
                "history_token_ids": payload.get("history_token_ids") or payload.get("token_ids") or [],
                "stop_token_ids": payload.get("stop_token_ids") or [],
                "sampling": payload.get("sampling") or {},
                "compute_time_ms": compute_ms,
                "hidden_transport": transport,
                "effective_quantization": transport,
                "hidden_encode_ms": hidden_encode_ms,
                "kv_cache": use_kv,
                "decode_mode": decode_mode,
                "attention_backend": "mlx_metal",
                "linear_scan_backend": self.scan_backend_effective,
                "runtime_backend": "mlx",
            }
            out.update(hidden_payload)
            out.update(hidden_metrics)
            return json.dumps(out).encode()

    # ── helpers ───────────────────────────────────────────────────────────────

    def _get_rope(self, mx: Any, layer_head_dim: int, cfg: dict) -> tuple[Any, Any]:
        """Retourne les fréquences RoPE pour un head_dim donné, avec cache."""
        if not hasattr(self, '_rope_cache'):
            self._rope_cache: dict[int, tuple[Any, Any]] = {}
        if layer_head_dim not in self._rope_cache:
            theta = float(cfg.get("rope_theta", 1_000_000.0))
            max_len = int(cfg.get("max_position_embeddings", 32768))
            cos, sin = _mx_rope_freqs(mx, layer_head_dim, max_len, theta)
            mx.eval(cos, sin)
            self._rope_cache[layer_head_dim] = (cos, sin)
        return self._rope_cache[layer_head_dim]

    def _probe_linear_attn_shapes(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        n_layers = self.shard.layer_end - self.shard.layer_start + 1
        for i in range(n_layers):
            prefix = f"layers.{i}"
            if self._has_linear_attn(prefix):
                out[prefix] = _linear_attn_shapes(self.weights, prefix)
        return out

    def _has_linear_attn(self, prefix: str) -> bool:
        return f"{prefix}.linear_attn.in_proj_qkv.weight" in self.weights

    def _linear_attn_forward(self, mx: Any, prefix: str, local_i: int, hidden: Any, use_cache: bool, rms_eps: float) -> tuple[Any, dict[str, Any]]:
        w_qkv = self._w(f"{prefix}.linear_attn.in_proj_qkv.weight")
        w_z = self._w(f"{prefix}.linear_attn.in_proj_z.weight")
        w_b = self._w(f"{prefix}.linear_attn.in_proj_b.weight")
        w_a = self._w(f"{prefix}.linear_attn.in_proj_a.weight")
        w_out = self._w(f"{prefix}.linear_attn.out_proj.weight")
        w_conv = self._w(f"{prefix}.linear_attn.conv1d.weight")
        dt_bias = self._w(f"{prefix}.linear_attn.dt_bias")
        a_log = self._w(f"{prefix}.linear_attn.A_log")
        norm_w = self._w(f"{prefix}.linear_attn.norm.weight")
        if any(v is None for v in [w_qkv, w_z, w_b, w_a, w_out, w_conv, dt_bias, a_log, norm_w]):
            raise ValueError(f"linear_attn_shape_mismatch:{prefix}:{_linear_attn_shapes(self.weights, prefix)}")

        cfg = self.shard.model_config
        num_v_heads = int(cfg.get("linear_num_value_heads") or int(a_log.shape[0]))
        num_k_heads = int(cfg.get("linear_num_key_heads") or num_v_heads)
        value_dim = int(w_z.shape[0])
        head_v_dim = value_dim // num_v_heads
        # conv_dim = key_dim*2 + value_dim, so key_dim = (w_qkv.shape[0] - value_dim) // 2
        total_qkv = int(w_qkv.shape[0])
        key_dim = (total_qkv - value_dim) // 2
        head_k_dim = key_dim // num_k_heads
        bsz, seq_len, _ = hidden.shape

        mixed = self._linear(hidden, f"{prefix}.linear_attn.in_proj_qkv")  # [B, L, key*2 + value]
        z = self._linear(hidden, f"{prefix}.linear_attn.in_proj_z").reshape(bsz, seq_len, num_v_heads, head_v_dim)
        b = self._linear(hidden, f"{prefix}.linear_attn.in_proj_b")        # [B, L, num_v_heads]
        a = self._linear(hidden, f"{prefix}.linear_attn.in_proj_a")        # [B, L, num_v_heads]

        state = self.linear_states[local_i] if self.linear_states is not None else {}
        conv_state = state.get("conv_state")
        rec_state = state.get("recurrent_state")
        mixed_bcl = mixed.transpose(0, 2, 1)
        conv_kernel = int(w_conv.shape[-1])
        if use_cache and conv_state is not None and seq_len == 1:
            combined = mx.concatenate([conv_state, mixed_bcl], axis=-1)
            mixed_conv = _causal_conv1d_mlx(mx, combined[:, :, -(conv_kernel):], w_conv)[:, :, -1:]
            new_conv_state = combined[:, :, -(conv_kernel - 1):]
        else:
            combined = mx.concatenate([conv_state, mixed_bcl], axis=-1) if (use_cache and conv_state is not None) else mixed_bcl
            mixed_conv = _causal_conv1d_mlx(mx, combined, w_conv)
            if use_cache and conv_state is not None:
                mixed_conv = mixed_conv[:, :, -seq_len:]
            new_conv_state = combined[:, :, -(conv_kernel - 1):]
        mixed_conv = mixed_conv.transpose(0, 2, 1)

        query, key, value = mx.split(mixed_conv, [key_dim, key_dim + key_dim], axis=-1)
        query = query.reshape(bsz, seq_len, num_k_heads, head_k_dim)
        key = key.reshape(bsz, seq_len, num_k_heads, head_k_dim)
        value = value.reshape(bsz, seq_len, num_v_heads, head_v_dim)
        beta = _mx_sigmoid(mx, b)
        g = -mx.exp(a_log.astype(mx.float32)) * _mx_softplus(mx, a.astype(mx.float32) + dt_bias)
        if num_v_heads // num_k_heads > 1:
            repeats = num_v_heads // num_k_heads
            query = mx.repeat(query, repeats, axis=2)
            key = mx.repeat(key, repeats, axis=2)

        out, new_rec_state = self._gated_delta_recurrent(mx, query, key, value, g, beta, rec_state, True)
        out2 = out.reshape(-1, head_v_dim)
        z2 = z.reshape(-1, head_v_dim)
        out2 = _gated_rms_norm(mx, out2, z2, norm_w, rms_eps)
        out = out2.reshape(bsz, seq_len, value_dim)
        out = self._linear(out, f"{prefix}.linear_attn.out_proj")

        if use_cache and self.linear_states is not None:
            self.linear_states[local_i] = {"conv_state": new_conv_state, "recurrent_state": new_rec_state}
        return out, {
            "linear_attn_state_shape": list(new_rec_state.shape) if new_rec_state is not None else None,
            "state_bytes": int(np.prod(new_rec_state.shape) * 4) if new_rec_state is not None else 0,
        }

    def _gated_delta_recurrent(self, mx: Any, query: Any, key: Any, value: Any, g: Any, beta: Any, initial_state: Any | None, output_final_state: bool) -> tuple[Any, Any | None]:
        backend = _normalize_scan_backend(os.environ.get(_SCAN_BACKEND_ENV, self.scan_backend_requested))
        if backend == "metal":
            try:
                from mlx_scan_metal import gated_delta_recurrent_metal
                out, state, meta = gated_delta_recurrent_metal(
                    mx, query, key, value, g, beta, initial_state, output_final_state
                )
                self.scan_backend_effective = str(meta.get("backend", "metal"))
                return out, state
            except NotImplementedError as exc:
                if _strict_metal_scan():
                    raise
                print(f"[mlx] scan metal indisponible ({exc}); fallback chunked")
                backend = "chunked"
            except Exception as exc:
                if _strict_metal_scan():
                    raise
                print(f"[mlx] scan metal erreur {type(exc).__name__}: {exc}; fallback chunked")
                backend = "chunked"

        eval_chunk = 1 if backend == "python" else max(1, int(os.environ.get("VRYX_MLX_SCAN_CHUNK", "16")))
        self.scan_backend_effective = backend
        return self._gated_delta_recurrent_chunked(
            mx, query, key, value, g, beta, initial_state, output_final_state, eval_chunk
        )

    def _gated_delta_recurrent_chunked(
        self,
        mx: Any,
        query: Any,
        key: Any,
        value: Any,
        g: Any,
        beta: Any,
        initial_state: Any | None,
        output_final_state: bool,
        eval_chunk: int,
    ) -> tuple[Any, Any | None]:
        # Implémentation MLX de référence. Le backend "python" évalue chaque
        # token, "chunked" conserve le chemin existant avec évaluation groupée.
        query = _mx_l2norm(mx, query, eps=1e-6).transpose(0, 2, 1, 3).astype(mx.float32)
        key = _mx_l2norm(mx, key, eps=1e-6).transpose(0, 2, 1, 3).astype(mx.float32)
        value = value.transpose(0, 2, 1, 3).astype(mx.float32)
        beta = beta.transpose(0, 2, 1).astype(mx.float32)
        g = g.transpose(0, 2, 1).astype(mx.float32)
        bsz, heads, seq_len, kdim = key.shape
        vdim = value.shape[-1]
        query = query * (kdim ** -0.5)

        state = initial_state if initial_state is not None else mx.zeros((bsz, heads, kdim, vdim), dtype=mx.float32)
        outs = []
        # Boucle sur les positions (nécessaire pour la récurrence causale)
        # mais avec mx.eval() par batch de tokens pour éviter la surcharge lazy graph
        for t in range(seq_len):
            q_t = query[:, :, t]                    # [B, H, D]
            k_t = key[:, :, t]
            v_t = value[:, :, t]
            g_t = mx.exp(g[:, :, t])[:, :, None, None]     # [B, H, 1, 1]
            beta_t = beta[:, :, t][:, :, None]              # [B, H, 1]
            state = state * g_t
            kv_mem = mx.sum(state * k_t[:, :, :, None], axis=-2)  # [B, H, V]
            delta = (v_t - kv_mem) * beta_t                        # [B, H, V]
            state = state + k_t[:, :, :, None] * delta[:, :, None, :]
            outs.append(mx.sum(state * q_t[:, :, :, None], axis=-2))
            if (t + 1) % eval_chunk == 0:
                mx.eval(*outs[-eval_chunk:], state)
        out = mx.stack(outs, axis=2).transpose(0, 2, 1, 3)
        mx.eval(out, state)
        return out, state if output_final_state else None

    def _w(self, name: str) -> Any | None:
        return self.weights.get(name)

    def _encode_hidden_payload(self, mx: Any, hidden: Any, transport: str) -> tuple[dict[str, Any], dict[str, Any]]:
        hidden_shape = [int(x) for x in hidden.shape]
        metrics: dict[str, Any] = {
            "hidden_shape": hidden_shape,
            "hidden_elements": int(np.prod(hidden_shape)),
            "hidden_encode_path": "mlx",
        }
        hidden_f16 = hidden.astype(mx.float16)

        if transport == "int8":
            max_abs_mx = mx.max(mx.abs(hidden_f16))
            mx.eval(max_abs_mx)
            max_abs = float(np.array(max_abs_mx, copy=False)) or 1.0
            scale = max(max_abs / 127.0, 1e-8)
            q_mx = mx.clip(mx.round(hidden_f16 / scale), -127, 127).astype(mx.int8)
            mx.eval(q_mx)
            q = np.array(q_mx, copy=False)
            metrics.update({
                "hidden_bytes": int(q.nbytes),
                "hidden_source_dtype": "fp16",
                "hidden_transfer_dtype": "int8",
            })
            return {
                "hidden_q_b64": base64.b64encode(q.tobytes()).decode(),
                "hidden_scale": scale,
                "hidden_zero_point": 0,
                "hidden_shape": hidden_shape,
                "hidden_dtype": "int8",
            }, metrics

        if transport == "q4":
            max_abs_mx = mx.max(mx.abs(hidden_f16))
            mx.eval(max_abs_mx)
            max_abs = float(np.array(max_abs_mx, copy=False)) or 1.0
            scale = max(max_abs / 7.0, 1e-8)
            q4_mx = mx.clip(mx.round(hidden_f16 / scale), -7, 7).astype(mx.int8)
            mx.eval(q4_mx)
            q4 = np.array(q4_mx, copy=False).reshape(-1)
            n = q4.size
            if n % 2:
                q4 = np.pad(q4, (0, 1), mode="constant")
            nib = (q4.astype(np.int16) + 8).astype(np.uint8)
            packed = (nib[0::2] & 0x0F) | ((nib[1::2] & 0x0F) << 4)
            metrics.update({
                "hidden_bytes": int(packed.nbytes),
                "hidden_source_dtype": "fp16",
                "hidden_transfer_dtype": "q4",
            })
            return {
                "hidden_q4_b64": base64.b64encode(packed.tobytes()).decode(),
                "hidden_scale": scale,
                "hidden_zero_point": 0,
                "hidden_shape": hidden_shape,
                "hidden_dtype": "q4",
                "hidden_q4_len": int(n),
            }, metrics

        mx.eval(hidden_f16)
        hs_np = np.array(hidden_f16, copy=False)
        metrics.update({
            "hidden_bytes": int(hs_np.nbytes),
            "hidden_source_dtype": "fp16",
            "hidden_transfer_dtype": "fp16",
        })
        return {
            "hidden_fp16_b64": base64.b64encode(hs_np.tobytes()).decode(),
            "hidden_shape": hidden_shape,
            "hidden_dtype": "fp16",
        }, metrics

    def _decode_hidden(self, payload: dict, hidden_size: int) -> Any | None:
        mx = self.mx
        if payload.get("hidden_q4_b64"):
            raw = base64.b64decode(payload["hidden_q4_b64"])
            shape = tuple(int(x) for x in payload["hidden_shape"])
            scale = float(payload.get("hidden_scale") or 1.0)
            total = int(payload.get("hidden_q4_len") or np.prod(shape))
            packed = np.frombuffer(raw, dtype=np.uint8)
            lo = (packed & 0x0F).astype(np.int8) - 8
            hi = ((packed >> 4) & 0x0F).astype(np.int8) - 8
            q = np.empty(packed.size * 2, dtype=np.int8)
            q[0::2] = lo; q[1::2] = hi
            q = q[:total].reshape(shape)
            return mx.array(q, dtype=mx.int8).astype(mx.float32) * scale

        if payload.get("hidden_q_b64"):
            raw = base64.b64decode(payload["hidden_q_b64"])
            shape = tuple(int(x) for x in payload["hidden_shape"])
            scale = float(payload.get("hidden_scale") or 1.0)
            q = np.frombuffer(raw, dtype=np.int8).reshape(shape)
            return mx.array(q, dtype=mx.int8).astype(mx.float32) * scale

        if payload.get("hidden_fp16_b64"):
            raw = base64.b64decode(payload["hidden_fp16_b64"])
            shape = tuple(int(x) for x in payload["hidden_shape"])
            hs = np.frombuffer(raw, dtype=np.float16).reshape(shape)
            return mx.array(hs, dtype=mx.float16)

        if payload.get("hidden_b64"):
            raw = base64.b64decode(payload["hidden_b64"])
            flat = np.frombuffer(raw, dtype=np.float32)
            seq_len = len(flat) // hidden_size
            return mx.array(flat.reshape(1, seq_len, hidden_size), dtype=mx.float32)

        return None

    def _topk_logits_cpu(self, mx: Any, logits: Any, k: int) -> tuple[np.ndarray, np.ndarray] | None:
        try:
            flat = logits.reshape(-1)
            vocab = int(flat.shape[0])
            k = max(1, min(int(k), vocab))
            if not all(hasattr(mx, name) for name in ("argpartition", "argsort")):
                return None
            idx = mx.argpartition(flat, -k)[-k:]
            vals = flat[idx]
            order = mx.argsort(-vals)
            idx = idx[order]
            vals = vals[order]
            mx.eval(idx, vals)
            return (
                np.array(idx, copy=False).astype(np.int64, copy=False),
                np.array(vals, copy=False).astype(np.float32, copy=False),
            )
        except Exception as exc:
            print(f"[mlx] sampling top-k prefilter fallback: {type(exc).__name__}: {exc}")
            return None

    def _sample(self, mx: Any, logits: Any, payload: dict) -> tuple[int, dict]:
        sampling = payload.get("sampling") if isinstance(payload.get("sampling"), dict) else {}
        temperature = float(sampling.get("temperature", float(os.environ.get("VRYX_SAMPLING_TEMPERATURE", "0.35"))))
        top_p = float(sampling.get("top_p", float(os.environ.get("VRYX_SAMPLING_TOP_P", "0.75"))))
        top_k = int(sampling.get("top_k", int(os.environ.get("VRYX_SAMPLING_TOP_K", "20"))))
        rep_penalty = float(sampling.get("repetition_penalty", float(os.environ.get("VRYX_REPETITION_PENALTY", "1.18"))))
        history = payload.get("history_token_ids") or []
        vocab_size = int(logits.reshape(-1).shape[0])

        # Greedy (T<=0) : toujours argmax MLX sur tout le vocabulaire.
        # L’ancien chemin NumPy + pénalité de répétition pouvait produire des logits mal
        # aplatis (forme / lazy eval) et des jetons incohérents, d’où un décodage vide côté VPS.
        if temperature <= 0:
            token_mx = mx.argmax(logits.reshape(-1))
            mx.eval(token_mx)
            return int(np.array(token_mx, copy=False)), {
                "sampling_mode": "greedy",
                "temperature": temperature,
                "sampling_backend": "mlx_argmax",
                "sampling_cpu_vocab_size": vocab_size,
                "sampling_prefilter": "argmax",
                "repetition_penalty_ignored": rep_penalty > 1.0,
            }

        prefilter_env = int(os.environ.get("VRYX_LM_HEAD_TOPK_PREFILTER", "0") or "0")
        recent_repeated = {
            int(t) for t in history[-512:]
            if isinstance(t, int) or (isinstance(t, str) and t.isdigit())
        }
        if top_k > 0:
            prefilter_k = top_k
            if rep_penalty > 1.0 and recent_repeated:
                prefilter_k = min(vocab_size, max(top_k * 4, top_k + len(recent_repeated)))
        else:
            prefilter_k = prefilter_env
        can_prefilter = (
            prefilter_k > 0
            and prefilter_k < vocab_size
            and os.environ.get("VRYX_DISABLE_MLX_SAMPLING_PREFILTER", "0").lower() not in ("1", "true", "yes")
        )
        topk = self._topk_logits_cpu(mx, logits, prefilter_k) if can_prefilter else None
        if topk is not None:
            candidate_ids, scores = topk
            scores = scores.astype(np.float32, copy=True)
            if rep_penalty > 1.0:
                candidate_pos = {int(tid): i for i, tid in enumerate(candidate_ids.tolist())}
                for tid in recent_repeated:
                    pos = candidate_pos.get(tid)
                    if pos is not None:
                        scores[pos] = scores[pos] / rep_penalty if scores[pos] > 0 else scores[pos] * rep_penalty

            scores /= max(temperature, 1e-5)
            if top_k > 0 and top_k < len(scores):
                kth_val = np.partition(scores, -top_k)[-top_k]
                scores = np.where(scores >= kth_val, scores, -np.inf)
            probs = np.exp(scores - np.max(scores))
            probs /= probs.sum()

            if 0.0 < top_p < 1.0:
                sorted_idx = np.argsort(-probs)
                cumulative = np.cumsum(probs[sorted_idx])
                cut = np.searchsorted(cumulative, top_p) + 1
                kept = sorted_idx[:cut]
                mask = np.zeros_like(probs)
                mask[kept] = 1.0
                probs = probs * mask
                probs /= probs.sum()

            token = int(np.random.choice(candidate_ids, p=probs))
            return token, {
                "sampling_mode": "multinomial",
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
                "repetition_penalty": rep_penalty,
                "sampling_backend": "mlx_topk_cpu",
                "sampling_cpu_vocab_size": int(scores.size),
                "sampling_prefilter": "top_k",
            }

        scores = np.array(logits, copy=True).astype(np.float32).squeeze()

        # Répétition penalty
        if rep_penalty > 1.0:
            for tid in set(int(t) for t in history[-512:] if isinstance(t, int)):
                if 0 <= tid < scores.size:
                    scores[tid] = scores[tid] / rep_penalty if scores[tid] > 0 else scores[tid] * rep_penalty

        scores /= max(temperature, 1e-5)

        if top_k > 0 and top_k < len(scores):
            kth_val = np.partition(scores, -top_k)[-top_k]
            scores = np.where(scores >= kth_val, scores, -np.inf)

        probs = np.exp(scores - np.max(scores))
        probs /= probs.sum()

        if 0.0 < top_p < 1.0:
            sorted_idx = np.argsort(-probs)
            cumulative = np.cumsum(probs[sorted_idx])
            cut = np.searchsorted(cumulative, top_p) + 1
            kept = sorted_idx[:cut]
            mask = np.zeros_like(probs)
            mask[kept] = 1.0
            probs = probs * mask
            probs /= probs.sum()

        token = int(np.random.choice(len(probs), p=probs))
        return token, {
            "sampling_mode": "multinomial",
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "repetition_penalty": rep_penalty,
            "sampling_backend": "cpu_full_vocab",
            "sampling_cpu_vocab_size": int(scores.size),
            "sampling_prefilter": "none",
        }

    def unload(self) -> None:
        self.weights.clear()
        self.kv_cache = None
        self.linear_states = None
        self.shard.weight_arrays.clear()
        if self.mx is not None:
            _mlx_clear_cache(self.mx)
        if _STATE_ALLOCATOR is not None:
            _STATE_ALLOCATOR.release(self.shard.session_id)

    def status(self) -> dict[str, Any]:
        state_bytes = 0
        if self.linear_states:
            for item in self.linear_states:
                rec = item.get("recurrent_state") if isinstance(item, dict) else None
                if rec is not None:
                    state_bytes += int(np.prod(rec.shape) * 4)
        return {
            "runtime_backend": self.name,
            "ready": bool(self.weights),
            "attention_backend": "mlx_metal" if self.available else None,
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "runtime_fallback_reason": self.unavailable_reason,
            "linear_attn_ready": any(".linear_attn." in key for key in self.weights),
            "batch_forward": True,
            "state_bytes": state_bytes,
            "state_pages": _STATE_ALLOCATOR.status() if _STATE_ALLOCATOR is not None else None,
            "rss_mb": round(_rss_mb(), 1),
            "weight_dtype": os.environ.get("VRYX_MLX_WEIGHT_DTYPE", "fp16"),
            "q4_hidden_transport_supported": bool(self.available),
        }

    def capabilities(self) -> dict[str, Any]:
        return {
            "runtime_backend": self.name,
            "supports_mlx": self.available,
            "supports_vllm": False,
            "supports_q4_weights": self.available,
            "weight_quantization": getattr(self.shard, "weight_quantization", "fp16"),
            "attention_backend": "mlx_metal" if self.available else None,
            "linear_scan_backend": self.scan_backend_effective,
            "linear_scan_backend_requested": self.scan_backend_requested,
            "flash_attention": self.available,
            "linear_attn_ready": any(".linear_attn." in key for key in self.weights),
            "batch_forward": True,
            "paged_kv_cache": False,
            "state_paging": _STATE_ALLOCATOR.status() if _STATE_ALLOCATOR is not None else None,
            "weight_dtype": os.environ.get("VRYX_MLX_WEIGHT_DTYPE", "fp16"),
            "q4_hidden_transport_supported": bool(self.available),
        }
