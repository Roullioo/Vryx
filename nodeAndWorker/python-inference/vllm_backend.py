"""Backend Nvidia Velocity : intégration vLLM feature-gated.

Le pipeline Vryx actuel route des shards de couches entre plusieurs workers.
vLLM, lui, est un moteur full-model avec PagedAttention. Ce backend expose donc
des capacités et des erreurs explicites tant que le worker n'est pas configuré
comme worker vLLM full-model, au lieu de masquer l'absence de runtime Nvidia.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any


def _enabled(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class VLLMBackend:
    name = "vllm"

    def __init__(self, shard: Any):
        self.shard = shard
        self.enabled = _enabled(os.environ.get("VRYX_ENABLE_VLLM_RUNTIME"))
        self.model_path = (
            os.environ.get("VRYX_VLLM_MODEL_PATH")
            or os.environ.get("VRYX_DIST_MODEL")
            or getattr(shard, "model_id", "")
        )
        self.tensor_parallel_size = int(os.environ.get("VRYX_VLLM_TENSOR_PARALLEL_SIZE", "1"))
        self.quantization = (os.environ.get("VRYX_VLLM_QUANTIZATION") or os.environ.get("VRYX_WEIGHT_QUANTIZATION") or "fp16").lower()
        self.max_model_len = int(os.environ.get("VRYX_VLLM_MAX_MODEL_LEN", "4096"))
        self.engine: Any | None = None
        self.sampling_params_cls: Any | None = None
        self.last_forward_ms = 0
        self.unavailable_reason = self._probe_unavailable_reason()

    def _probe_unavailable_reason(self) -> str | None:
        if not self.enabled:
            return "vllm_runtime_feature_gate_disabled: set VRYX_ENABLE_VLLM_RUNTIME=1"
        try:
            import torch
        except Exception as exc:
            return f"torch_import_failed:{exc}"
        if not torch.cuda.is_available():
            return "cuda_unavailable:vLLM requires a Nvidia CUDA worker"
        try:
            import vllm  # noqa: F401
        except Exception as exc:
            return f"vllm_import_failed:{exc}"
        if not self.model_path:
            return "vllm_model_path_missing:set VRYX_VLLM_MODEL_PATH or VRYX_DIST_MODEL"
        return None

    @property
    def available(self) -> bool:
        return self.unavailable_reason is None

    def build(self) -> dict[str, Any]:
        if not self.available:
            return {
                "ok": False,
                "runtime_backend": self.name,
                "error": self.unavailable_reason,
                "runtime_fallback_reason": self.unavailable_reason,
                "supports_vllm": False,
            }

        total_layers = int(self.shard.model_config.get("num_hidden_layers_total") or self.shard.model_config.get("n_layer") or 0)
        owns_full_model_span = (
            bool(self.shard.has_embedding)
            and bool(self.shard.has_lm_head)
            and int(self.shard.layer_start) == 0
            and (total_layers <= 0 or int(self.shard.layer_end) >= total_layers - 1)
        )
        if not owns_full_model_span:
            reason = "vllm_full_model_required:current_daisy_chain_shards_cannot_be_executed_by_vllm"
            return {
                "ok": False,
                "runtime_backend": self.name,
                "error": reason,
                "runtime_fallback_reason": reason,
                "supports_vllm": True,
                "paged_attention": True,
                "attention_backend": "paged_attention",
            }

        t0 = time.perf_counter()
        try:
            from vllm import LLM, SamplingParams

            kwargs: dict[str, Any] = {
                "model": self.model_path,
                "tensor_parallel_size": self.tensor_parallel_size,
                "max_model_len": self.max_model_len,
                "trust_remote_code": True,
            }
            if self.quantization not in ("", "none", "fp16", "float16", "bf16", "bfloat16"):
                kwargs["quantization"] = self.quantization
            self.engine = LLM(**kwargs)
            self.sampling_params_cls = SamplingParams
            elapsed = int((time.perf_counter() - t0) * 1000)
            self.shard.build_ms = elapsed
            return {
                "ok": True,
                "runtime_backend": self.name,
                "build_ms": elapsed,
                "model_path": self.model_path,
                "supports_vllm": True,
                "paged_attention": True,
                "attention_backend": "paged_attention",
                "weight_quantization": self.quantization,
            }
        except Exception as exc:
            reason = f"vllm_engine_build_failed:{type(exc).__name__}:{exc}"
            self.unavailable_reason = reason
            return {
                "ok": False,
                "runtime_backend": self.name,
                "error": reason,
                "runtime_fallback_reason": reason,
                "supports_vllm": True,
            }

    def forward(self, data: bytes, session_id: str) -> bytes:
        if self.engine is None or self.sampling_params_cls is None:
            return json.dumps({
                "ok": False,
                "error": self.unavailable_reason or "vllm_engine_not_built",
                "session_id": session_id,
                "runtime_backend": self.name,
            }).encode()
        try:
            payload = json.loads(data.decode("utf-8", errors="replace")) if data else {}
        except Exception:
            payload = {}
        token_ids = payload.get("token_ids")
        if not isinstance(token_ids, list) or not token_ids:
            return json.dumps({
                "ok": False,
                "error": "vllm_forward_requires_token_ids",
                "session_id": session_id,
                "runtime_backend": self.name,
            }).encode()

        sampling = payload.get("sampling") if isinstance(payload.get("sampling"), dict) else {}
        params = self.sampling_params_cls(
            max_tokens=1,
            temperature=float(sampling.get("temperature", 0.0)),
            top_p=float(sampling.get("top_p", 1.0)),
            top_k=int(sampling.get("top_k", -1)),
        )
        t0 = time.perf_counter()
        try:
            outputs = self.engine.generate(prompt_token_ids=[int(x) for x in token_ids], sampling_params=params)
            self.last_forward_ms = max(1, int((time.perf_counter() - t0) * 1000))
            out0 = outputs[0].outputs[0] if outputs and outputs[0].outputs else None
            generated = list(getattr(out0, "token_ids", []) or [])
            if not generated:
                return json.dumps({
                    "ok": False,
                    "error": "vllm_no_token_generated",
                    "session_id": session_id,
                    "runtime_backend": self.name,
                    "compute_time_ms": self.last_forward_ms,
                }).encode()
            return json.dumps({
                "ok": True,
                "next_token_id": int(generated[-1]),
                "candidate_token_ids": [int(generated[-1])],
                "accepted_token_count": 1,
                "session_id": session_id,
                "runtime_backend": self.name,
                "compute_time_ms": self.last_forward_ms,
                "attention_backend": "paged_attention",
                "paged_attention": True,
            }).encode()
        except Exception as exc:
            return json.dumps({
                "ok": False,
                "error": f"vllm_forward_failed:{type(exc).__name__}:{exc}",
                "session_id": session_id,
                "runtime_backend": self.name,
            }).encode()

    def unload(self) -> None:
        self.engine = None
        return None

    def status(self) -> dict[str, Any]:
        ready = self.engine is not None
        return {
            "runtime_backend": self.name,
            "ready": ready,
            "runtime_fallback_reason": self.unavailable_reason,
            "attention_backend": "paged_attention" if self.available else "vllm_unavailable",
            "paged_attention": self.available,
            "paged_kv_cache": self.available,
            "flash_attention": self.available,
            "last_forward_ms": self.last_forward_ms,
            "model_path": self.model_path,
        }

    def capabilities(self) -> dict[str, Any]:
        support = self.available or self.enabled
        return {
            "runtime_backend": self.name,
            "supports_vllm": support,
            "supports_mlx": False,
            "supports_q4_weights": self.quantization in ("awq", "gptq", "exl2", "fp8"),
            "weight_quantization": "exl2",
            "attention_backend": "paged_attention" if support else "vllm_unavailable",
            "paged_attention": True,
            "paged_kv_cache": support,
            "flash_attention": support,
            "cuda_graphs": support,
            "continuous_batching": support,
            "runtime_fallback_reason": self.unavailable_reason,
            "q4_hidden_transport_supported": False,
        }
