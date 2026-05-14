"""Scan Gated Delta sur GPU via Metal (MLX `fast.metal_kernel`).

Utilisé lorsque `VRYX_MLX_SCAN_BACKEND=metal`. Un thread traite la récurrence
causale sur L pour une paire (batch, tête) en parallèle sur B*H, ce qui supprime
la boucle Python sur le temps du chemin `chunked`.

Entrées (même convention que ``MLXBackend._gated_delta_recurrent_chunked`` avant
normalisation) : query/key/value ``[B, L, H, *]``, g/beta ``[B, L, H]``.
"""
from __future__ import annotations

from typing import Any

_KERNEL = None

# Corps du kernel : q/k/v sont [B,H,L,K] ou [B,H,L,V], g/beta [B,H,L], h0/state [B,H,K,V]
_GATED_DELTA_METAL_SOURCE = r"""
    const uint bh = thread_position_in_grid.x;
    const int B = q_shape[0];
    const int H = q_shape[1];
    const int L = q_shape[2];
    const int Kdim = q_shape[3];
    const int Vdim = v_shape[3];

    if (bh >= (uint)(B * H)) {
        return;
    }

    const int b = int(bh / (uint)H);
    const int h = int(bh % (uint)H);

    const uint nkv = (uint)(Kdim * Vdim);
    const uint state_base = bh * nkv;
    const uint bh_stride_t = ((uint)b * (uint)H + (uint)h) * (uint)L;

    // Reprendre l'état initial (souvent zéros)
    for (uint i = 0; i < nkv; ++i) {
        state_out[state_base + i] = h0[state_base + i];
    }

    for (int t = 0; t < L; ++t) {
        const uint g_idx = bh_stride_t + (uint)t;
        const T gt = metal::exp(g[g_idx]);

        for (uint i = 0; i < nkv; ++i) {
            state_out[state_base + i] *= gt;
        }

        const uint qkv_t_off = bh_stride_t * (uint)Kdim + (uint)t * (uint)Kdim;
        const uint v_t_off = bh_stride_t * (uint)Vdim + (uint)t * (uint)Vdim;

        for (uint vv = 0; vv < (uint)Vdim; ++vv) {
            T kv_mem = T(0);
            for (uint kk = 0; kk < (uint)Kdim; ++kk) {
                const T st = state_out[state_base + kk * (uint)Vdim + vv];
                const T kt = k[qkv_t_off + kk];
                kv_mem += st * kt;
            }
            const T vt = v[v_t_off + vv];
            const T bt = beta[g_idx];
            const T delta = (vt - kv_mem) * bt;
            for (uint kk = 0; kk < (uint)Kdim; ++kk) {
                const T kt = k[qkv_t_off + kk];
                state_out[state_base + kk * (uint)Vdim + vv] += kt * delta;
            }
        }

        for (uint vv = 0; vv < (uint)Vdim; ++vv) {
            T oacc = T(0);
            for (uint kk = 0; kk < (uint)Kdim; ++kk) {
                const T st = state_out[state_base + kk * (uint)Vdim + vv];
                const T qt = q[qkv_t_off + kk];
                oacc += st * qt;
            }
            out[bh_stride_t * (uint)Vdim + (uint)t * (uint)Vdim + vv] = oacc;
        }
    }
"""


def _get_metal_kernel(mx: Any) -> Any:
    global _KERNEL
    if _KERNEL is None:
        _KERNEL = mx.fast.metal_kernel(
            name="vryx_gated_delta_recurrent",
            input_names=["q", "k", "v", "g", "beta", "h0"],
            output_names=["out", "state_out"],
            source=_GATED_DELTA_METAL_SOURCE,
        )
    return _KERNEL


def _mx_l2norm_head(mx: Any, x: Any, eps: float = 1e-6) -> Any:
    return x * mx.rsqrt(mx.sum(x * x, axis=-1, keepdims=True) + eps)


def _prepare_scan_inputs(
    mx: Any,
    query: Any,
    key: Any,
    value: Any,
    g: Any,
    beta: Any,
) -> tuple[Any, Any, Any, Any, Any, int]:
    """Aligne q/k/v/g/beta sur [B,H,L,K] / [B,H,L,V] comme le chemin chunked."""
    query_n = _mx_l2norm_head(mx, query, eps=1e-6)
    key_n = _mx_l2norm_head(mx, key, eps=1e-6)
    qh = query_n.transpose(0, 2, 1, 3).astype(mx.float32)
    kh = key_n.transpose(0, 2, 1, 3).astype(mx.float32)
    vh = value.transpose(0, 2, 1, 3).astype(mx.float32)
    gh = g.transpose(0, 2, 1).astype(mx.float32)
    bh = beta.transpose(0, 2, 1).astype(mx.float32)
    kdim = int(key.shape[-1])
    qh = qh * (kdim**-0.5)
    return qh, kh, vh, gh, bh, kdim


def metal_prototype_status() -> dict[str, Any]:
    try:
        import mlx.core as mx

        avail = bool(mx.metal.is_available())
    except Exception:
        avail = False
    return {
        "backend": "metal",
        "implemented": avail,
        "scope": "gated_delta_scan",
        "reason": "metal_kernel vryx_gated_delta_recurrent (per head serial over L)" if avail else "mlx_metal_unavailable",
        "source_bytes": len(_GATED_DELTA_METAL_SOURCE),
    }


def gated_delta_recurrent_metal(
    mx: Any,
    query: Any,
    key: Any,
    value: Any,
    g: Any,
    beta: Any,
    initial_state: Any | None,
    output_final_state: bool,
) -> tuple[Any, Any | None, dict[str, Any]]:
    if query.ndim != 4 or key.ndim != 4 or value.ndim != 4:
        raise ValueError("expected query/key/value with shape [B, L, H, D]")
    if g.ndim != 3 or beta.ndim != 3:
        raise ValueError("expected g/beta with shape [B, L, H]")
    if query.shape[:3] != key.shape[:3] or value.shape[:3] != query.shape[:3]:
        raise ValueError(
            f"incompatible q/k/v prefixes: q={query.shape} k={key.shape} v={value.shape}"
        )
    if g.shape != beta.shape or g.shape != query.shape[:3]:
        raise ValueError(f"incompatible gate shapes: g={g.shape} beta={beta.shape} q={query.shape}")

    if not mx.metal.is_available():
        raise NotImplementedError("mlx_metal_unavailable")

    qh, kh, vh, gh, bh, kdim = _prepare_scan_inputs(mx, query, key, value, g, beta)
    bsz, nheads, seq_len, _kd = qh.shape
    _, _, _, vdim = vh.shape

    if initial_state is not None:
        h0 = initial_state.astype(mx.float32)
    else:
        h0 = mx.zeros((bsz, nheads, kdim, vdim), dtype=mx.float32)

    kernel = _get_metal_kernel(mx)
    grid_x = max(1, bsz * nheads)
    tg = min(256, grid_x)

    outs = kernel(
        inputs=[qh, kh, vh, gh, bh, h0],
        template=[("T", mx.float32)],
        grid=(grid_x, 1, 1),
        threadgroup=(tg, 1, 1),
        output_shapes=[(bsz, nheads, seq_len, vdim), (bsz, nheads, kdim, vdim)],
        output_dtypes=[mx.float32, mx.float32],
    )
    out_bh = outs[0]
    state_out = outs[1]
    mx.eval(out_bh, state_out)

    out = out_bh.transpose(0, 2, 1, 3)
    meta = {
        "backend": "metal",
        "kernel": "vryx_gated_delta_recurrent",
        "grid": grid_x,
    }
    if not output_final_state:
        return out, None, meta
    return out, state_out, meta
