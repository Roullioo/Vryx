"""
Serveur gRPC d'inférence Vryx — Pipeline Parallelism (Daisy Chain).

Stage 1 (VPS / Initiateur) :
  - Charge uniquement le tokenizer/config et sert les poids du modèle depuis le SSD.
  - Pousse les tranches de couches aux workers via P2P (vryx.shard.*).
  - Tokenise le prompt et lance la boucle autorégressive :
      token_ids → [worker1 embed+layers] → [worker2 layers] → [worker3 lm_head]
      → next_token_id → dé-tokenise → loop
  - JAMAIS de génération de texte ni de modèle complet côté VPS/initiateur.

Stage 2 (Worker) :
  - Reçoit vryx.shard.init/load/build/forward/pipeline/unload.
  - Exécute les couches PyTorch avec les poids reçus (Zero-Copy float16).
  - Retourne hidden_states (intermédiaires) ou next_token_id (dernier worker).
  - Aucun modèle téléchargé localement.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
import warnings

import grpc

warnings.filterwarnings("ignore")

import vryx_pb2
import vryx_pb2_grpc

import distributed_llm_orchestrator
import shard_runtime

# tensor_parallel_orchestrator (optionnel, importé si disponible)
try:
    import tensor_parallel_orchestrator
    _HAS_TP = True
except ImportError:
    _HAS_TP = False


# ── Helpers Ollama (fallback développement) ────────────────────────────────────

def _ollama_url() -> str:
    return os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def _default_model(stage: int) -> str:
    env = os.environ.get("OLLAMA_MODEL", "").strip()
    if env:
        return env
    if stage == 1:
        return os.environ.get("OLLAMA_MODEL_STAGE1", "gemma2:2b")
    return "vryx-worker"


_SYSTEM_PROMPT = (
    "Tu es Vryx, un assistant IA concis et direct. "
    "Réponds toujours dans la même langue que l'utilisateur. "
    "Sois précis et utile."
)


def _ollama_generate_blocking(prompt: str, model: str) -> dict:
    url = f"{_ollama_url()}/api/chat"
    payload = json.dumps({
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        ollama_timeout = max(600.0, float(os.environ.get("VRYX_OLLAMA_TIMEOUT_SEC", "600")))
        with urllib.request.urlopen(req, timeout=ollama_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            msg = data.get("message") or {}
            text = (msg.get("content") or data.get("response") or "").strip()
            pt = int(data.get("prompt_eval_count") or 0)
            ct = int(data.get("eval_count") or 0)
            dur_ns = data.get("total_duration")
            vps_ms = int((dur_ns or 0) / 1_000_000) if isinstance(dur_ns, (int, float)) else 0
            return {"text": text, "prompt_tokens": pt, "completion_tokens": ct,
                    "total_tokens": pt + ct, "vps_delegate_ms": vps_ms}
    except Exception as e:
        print(f"[!] Ollama fallback indisponible ({e}).")
        return {"text": "", "prompt_tokens": 0, "completion_tokens": 0,
                "total_tokens": 0, "vps_delegate_ms": 0}


async def _ollama_generate(prompt: str, model: str) -> dict:
    return await asyncio.to_thread(_ollama_generate_blocking, prompt, model)


# ── Proto helper ───────────────────────────────────────────────────────────────

def _proto_from_text(text: str, start_ns: int, metrics: dict,
                     pipeline_trace_json: str = "", compute_time_ms: int = 0,
                     shard_session_id: str = "") -> vryx_pb2.ProcessedTensorData:
    return vryx_pb2.ProcessedTensorData(
        data=text.encode("utf-8"),
        compute_time_ns=time.perf_counter_ns() - start_ns,
        serialization_time_ns=0,
        prompt_tokens=int(metrics.get("prompt_tokens") or 0),
        completion_tokens=int(metrics.get("completion_tokens") or 0),
        total_tokens=int(metrics.get("total_tokens") or 0),
        vps_delegate_ms=int(metrics.get("vps_delegate_ms") or 0),
        pipeline_trace_json=pipeline_trace_json or "",
        compute_time_ms=compute_time_ms,
        shard_session_id=shard_session_id or "",
    )


def _proto_from_bytes(data: bytes, start_ns: int, compute_ms: int,
                      pipeline_trace_json: str = "", sid: str = "",
                      lid: int = 0) -> vryx_pb2.ProcessedTensorData:
    return vryx_pb2.ProcessedTensorData(
        data=data,
        compute_time_ns=time.perf_counter_ns() - start_ns,
        serialization_time_ns=0,
        pipeline_trace_json=pipeline_trace_json or "",
        compute_time_ms=compute_ms,
        shard_session_id=sid or "",
        shard_layer_id=int(lid or 0),
    )


# ── Service gRPC ───────────────────────────────────────────────────────────────

class InferenceService(vryx_pb2_grpc.InferenceServiceServicer):
    def __init__(self, stage: int):
        self.stage = stage
        self.model = _default_model(stage)

        if stage == 1:
            print(
                "[*] Stage 1 (initiateur) — Pipeline Parallelism P2P : "
                "tokenizer/config côté VPS, shards safetensors servis aux workers."
            )
        else:
            print(
                f"[*] Stage 2 (worker) — reçoit poids depuis VPS et exécute "
                f"des couches Qwen/Qwen3 via gRPC (vryx.shard.*). Aucun modèle local requis."
            )

    async def ReportCapabilities(self, request, context):
        ram = int(request.ram_available_mb or 0)
        return vryx_pb2.CapabilitiesAck(
            ok=True,
            message=f"capabilities_ok ram_mb={ram} runtime=vryx-pipeline",
        )

    async def PingShardRuntime(self, request, context):
        start = time.perf_counter_ns()
        sid = request.session_id or "ping"
        msg = shard_runtime.shard_init(sid, int(request.ttl_sec or 60),
                                        int(request.layer_start), int(request.layer_end),
                                        request.model_tag or "")
        return vryx_pb2.ProcessedTensorData(
            data=msg.encode("utf-8"),
            compute_time_ns=time.perf_counter_ns() - start,
            shard_session_id=sid,
        )

    async def Process(self, request, context):
        start = time.perf_counter_ns()
        dtype = getattr(request, "dtype", "") or ""
        raw = bytes(request.data) if request.data else b""
        routing_path = list(getattr(request, "routing_path", []) or [])
        session_id = getattr(request, "session_id", "") or ""

        # ── vryx.pool.status (stage 1) ───────────────────────────────────────
        if dtype == "vryx.pool.status":
            if self.stage == 1:
                result = distributed_llm_orchestrator.get_pool_snapshot()
            else:
                result = {"ok": True, "stage": 2, "worker": shard_runtime.pipeline_shard_status(raw)}
            return _proto_from_bytes(json.dumps(result, ensure_ascii=False).encode(), start, 0)

        # ── Ping léger pour matrice de latence hot pool ──────────────────────
        if dtype == "vryx.ping.peer":
            try:
                payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
            except Exception:
                payload = {}
            result = {
                "ok": True,
                "peer_stage": self.stage,
                "echo": payload,
                "received_ms": int(time.time() * 1000),
            }
            return _proto_from_bytes(json.dumps(result, ensure_ascii=False).encode(), start, 0)

        # ── Circuit chaud persistant logique : ouvre/ferme une session pool ──
        if dtype in ("vryx.stream.open", "vryx.stream.close", "vryx.stream.heartbeat"):
            try:
                payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
            except Exception:
                payload = {}
            result = {
                "ok": True,
                "session_id": payload.get("session_id") or session_id,
                "pool_id": payload.get("pool_id"),
                "mode": dtype,
                "fallback": "persistent_request_response" if payload.get("persistent_relay") else "request_response",
                "persistent_session": True,
                "persistent_relay": bool(payload.get("persistent_relay")),
                "connection_reuse": bool(payload.get("persistent_relay")),
                "pipeline_overlap": bool(payload.get("pipeline_overlap")),
                "double_buffering": bool(payload.get("pipeline_overlap")),
                "quic_requested": bool(payload.get("hidden_quic")),
                "quic_available": False,
                "quic_used": False,
                "fallback_reason": "native_quic_not_enabled_in_worker",
                "received_ms": int(time.time() * 1000),
            }
            return _proto_from_bytes(json.dumps(result, ensure_ascii=False).encode(), start, 0)

        # ── Prefix cache partagé prototype ───────────────────────────────────
        if dtype == "vryx.cache.save":
            result = shard_runtime.pipeline_cache_save(raw)
            return _proto_from_bytes(result.encode(), start, 0)
        if dtype == "vryx.cache.load":
            result = shard_runtime.pipeline_cache_load(raw)
            return _proto_from_bytes(result.encode(), start, 0)
        if dtype == "vryx.cache.status":
            result = shard_runtime.pipeline_cache_status(raw)
            return _proto_from_bytes(result.encode(), start, 0)

        # ── QUIC expérimental : probe de capacité, fallback obligatoire ──────
        if dtype == "vryx.quic.probe":
            quic_enabled = os.environ.get("VRYX_HIDDEN_QUIC", "0").lower() in ("1", "true", "yes")
            result = {
                "ok": True,
                "quic_requested": True,
                "quic_available": quic_enabled,
                "quic_used": quic_enabled,
                "fallback": "native_quic_enabled" if quic_enabled else "request_response",
                "fallback_reason": None if quic_enabled else "native_quic_transport_disabled",
                "received_ms": int(time.time() * 1000),
            }
            return _proto_from_bytes(json.dumps(result, ensure_ascii=False).encode(), start, 0)

        # ── Génération directe mlx-lm officiel ────────────────────────────────
        if dtype == "vryx.mlx_lm.generate":
            t0 = time.perf_counter()
            out_bytes = shard_runtime.mlx_lm_direct_generate(raw)
            compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
            return _proto_from_bytes(out_bytes, start, compute_ms, sid=session_id or "")

        # ── vryx.shard.init ───────────────────────────────────────────────────
        if dtype == "vryx.shard.init":
            result = shard_runtime.pipeline_shard_init(raw)
            return _proto_from_bytes(result.encode(), start, 0)

        # ── vryx.shard.load ───────────────────────────────────────────────────
        if dtype == "vryx.shard.load":
            result = shard_runtime.pipeline_shard_load(raw)
            return _proto_from_bytes(result.encode(), start, 0)

        # ── vryx.shard.build ──────────────────────────────────────────────────
        if dtype == "vryx.shard.build":
            try:
                sid = json.loads(raw.decode("utf-8", errors="replace")).get("session_id", session_id)
            except Exception:
                sid = session_id
            result = shard_runtime.pipeline_shard_build(sid)
            return _proto_from_bytes(result.encode(), start, 0)

        # ── vryx.shard.status ─────────────────────────────────────────────────
        if dtype == "vryx.shard.status":
            result = shard_runtime.pipeline_shard_status(raw)
            return _proto_from_bytes(result.encode(), start, 0)

        # ── vryx.shard.unload ─────────────────────────────────────────────────
        if dtype == "vryx.shard.unload":
            try:
                sid = json.loads(raw.decode("utf-8", errors="replace")).get("session_id", session_id)
            except Exception:
                sid = session_id
            msg = shard_runtime.shard_unload(sid or session_id)
            return _proto_from_bytes(msg.encode(), start, 0)

        # ── vryx.shard.pipeline / vryx.pipeline.forward ──────────────────────
        # Pipeline Parallelism : forward pass à travers les couches de ce worker.
        if dtype in ("vryx.shard.pipeline", "vryx.pipeline.forward"):
            t0 = time.perf_counter()

            # Détecter le session_id (dans le payload JSON ou dans le champ proto)
            try:
                payload_obj = json.loads(raw.decode("utf-8", errors="replace"))
                sid = str(payload_obj.get("session_id") or session_id or "")
            except Exception:
                sid = session_id or ""

            out_bytes = shard_runtime.pipeline_shard_forward(raw, sid)
            compute_ms = max(1, int((time.perf_counter() - t0) * 1000))

            # Trace minimale pour l'UI
            trace = json.dumps({
                "layout": "pipeline_relay_daisy_chain",
                "ok": True,
                "routing_path": routing_path,
                "compute_time_ms": compute_ms,
                "session_id": sid,
            }, ensure_ascii=False)

            return _proto_from_bytes(out_bytes, start, compute_ms,
                                     pipeline_trace_json=trace, sid=sid)

        # ── vryx.shard.* (ancien protocole shard init/forward/unload) ────────
        if dtype.startswith("vryx.shard.") or dtype.startswith("vryx.dist.") or dtype.startswith("vryx.tp."):
            try:
                out, metrics, sid, lid, c_ms = _handle_legacy_shard(dtype, raw, session_id)
            except Exception as e:
                out, metrics, sid, lid, c_ms = f"[vryx.shard] erreur : {e}", {}, "", 0, 0
            trace = json.dumps({
                "layout": "pipeline_relay_daisy_chain",
                "ok": True,
                "routing_path": routing_path,
                "compute_time_ms": c_ms,
                "session_id": sid,
            }, ensure_ascii=False)
            if isinstance(out, bytes):
                return _proto_from_bytes(out, start, c_ms, pipeline_trace_json=trace, sid=sid, lid=lid)
            return _proto_from_text(str(out), start, metrics,
                                    pipeline_trace_json=trace, compute_time_ms=c_ms,
                                    shard_session_id=sid)

        # ── Prompt texte (stage 1 uniquement) ─────────────────────────────────
        request_options = {}
        if dtype == "text":
            try:
                prompt = raw.decode("utf-8", errors="replace")
            except Exception:
                prompt = ""
            try:
                maybe_payload = json.loads(prompt)
                if isinstance(maybe_payload, dict) and isinstance(maybe_payload.get("prompt"), str):
                    prompt = maybe_payload.get("prompt", "")
                    request_options = {
                        "hidden_transport": maybe_payload.get("hidden_transport") or maybe_payload.get("quantization"),
                        "quantization": maybe_payload.get("quantization") or maybe_payload.get("hidden_transport"),
                        "pool_preference": maybe_payload.get("pool_preference"),
                    }
                    if "max_new_tokens" in maybe_payload and maybe_payload.get("max_new_tokens") is not None:
                        request_options["max_new_tokens"] = maybe_payload.get("max_new_tokens")
            except Exception:
                request_options = {}
        else:
            try:
                inner = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                inner = ""
            prompt = f"Contexte :\n{inner}\n\nRéponse :"

        if self.stage == 2:
            return _proto_from_text(
                "[Vryx] Ce worker exécute seulement des couches gRPC. "
                "Envoyez vryx.shard.pipeline, pas du texte direct.",
                start, {}, compute_time_ms=0,
            )

        # Stage 1 : inférence distribuée Pipeline Parallelism
        print(f"[>] Chat P2P : {len(prompt)} chars, routing_path={routing_path}")
        compute_start = time.perf_counter_ns()

        def _run_pipeline():
            return distributed_llm_orchestrator.maybe_run_worker_only_chat(prompt, request_options)

        pipeline_result = None
        try:
            pipeline_result = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(None, _run_pipeline),
                timeout=3600.0,
            )
        except asyncio.TimeoutError:
            print("[!] Timeout pipeline P2P.")
            pipeline_result = {
                "ok": False,
                "error": "Timeout pipeline P2P (3600s).",
                "trace": {
                    "layout": "pipeline_relay_daisy_chain",
                    "ok": False,
                    "routing_path": list(routing_path),
                    "failure_stage": "asyncio_timeout",
                },
                "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
            }
        except Exception as e:
            print(f"[!] Erreur pipeline : {e}")
            pipeline_result = {
                "ok": False,
                "text": "",
                "error": f"Exception orchestrateur stage1 : {e}",
                "trace": {
                    "layout": "pipeline_relay_daisy_chain",
                    "ok": False,
                    "routing_path": list(routing_path),
                    "failure_stage": "executor_exception",
                },
                "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
            }

        compute_ms = max(0, int((time.perf_counter_ns() - compute_start) / 1_000_000))

        # Résultat du pipeline distribué
        pr = pipeline_result or {}
        pr_ok = bool(pr.get("ok"))
        raw_text = pr.get("text")
        text_out = raw_text if isinstance(raw_text, str) else ("" if raw_text is None else str(raw_text))
        metrics = pr.get("metrics") or {}
        ct = int(metrics.get("completion_tokens") or 0)
        # Succès : l'orchestrateur peut renvoyer ok=True avec texte vide après nettoyage
        # (tokens spéciaux / template) — ne pas traiter comme « Pipeline P2P indisponible ».
        if pr_ok and (text_out.strip() or ct > 0):
            if not text_out.strip() and ct > 0:
                print(
                    f"[!] Pipeline OK mais décodage vide (completion_tokens={ct}) — message de secours.",
                    flush=True,
                )
                text_out = (
                    f"[{ct} jetons générés ; aucune sortie textuelle après décodage. "
                    "Vérifier le chat template et les stop tokens.]"
                )
            trace_obj = pr.get("trace") or {}
            trace_obj["compute_time_ms"] = compute_ms
            trace_obj["ok"] = True
            trace_obj.pop("error", None)
            pipeline_trace_json = json.dumps(trace_obj, ensure_ascii=False)
            print(f"[>] Pipeline OK : {len(text_out)} chars, {compute_ms}ms")
            return _proto_from_text(
                text_out, start, metrics,
                pipeline_trace_json=pipeline_trace_json,
                compute_time_ms=compute_ms,
            )

        # Pipeline a échoué — le VPS NE CALCULE PAS, on remonte l'erreur explicite.
        err_msg = pr.get("error", "Pipeline P2P indisponible.")
        if pr_ok and not text_out.strip() and ct == 0:
            err_msg = pr.get("error") or "Pipeline P2P : aucun jeton généré."
        err_trace: dict = dict(pr.get("trace") or {})
        if not err_trace:
            err_trace = {"layout": "pipeline_relay_daisy_chain", "ok": False, "routing_path": list(routing_path)}
        err_trace.setdefault("layout", "pipeline_relay_daisy_chain")
        err_trace["ok"] = False
        _rp_err = list(err_trace.get("routing_path") or [])
        _peer_err = list(err_trace.get("peers") or [])
        if not _rp_err and _peer_err:
            err_trace["routing_path"] = _peer_err
        elif not _rp_err and routing_path:
            err_trace["routing_path"] = list(routing_path)
        err_trace["compute_wall_ms"] = compute_ms
        err_trace["timing_scope"] = "stage1_wall_ms"
        err_trace["compute_time_ms"] = compute_ms
        err_trace.setdefault("error", err_msg)
        text_out = err_msg
        err_metrics = pr.get("metrics") or {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0
        }
        print(f"[!] Pipeline KO : {err_msg}")
        return _proto_from_text(
            text_out, start, err_metrics,
            pipeline_trace_json=json.dumps(err_trace, ensure_ascii=False),
            compute_time_ms=compute_ms,
        )

    async def ProcessStream(self, request, context):
        start = time.perf_counter()
        yield vryx_pb2.StreamChunk(
            event="stage",
            json=json.dumps({"stage": "stage1_started", "status": "Pipeline P2P démarré"}, ensure_ascii=False),
            elapsed_ms=0,
        )
        if self.stage == 2:
            yield vryx_pb2.StreamChunk(
                event="error",
                error="ProcessStream est réservé au stage 1 initiateur.",
                done=True,
                elapsed_ms=int((time.perf_counter() - start) * 1000),
            )
            return

        response = await self.Process(request, context)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        trace = {}
        try:
            trace = json.loads(response.pipeline_trace_json or "{}")
        except Exception:
            trace = {}
        text = bytes(response.data or b"").decode("utf-8", errors="replace")
        token_events = trace.get("token_events") if isinstance(trace, dict) else None
        if isinstance(token_events, list) and token_events:
            for event in token_events:
                if not isinstance(event, dict):
                    continue
                token = str(event.get("text") or "")
                if token:
                    yield vryx_pb2.StreamChunk(
                        event="token",
                        token=token,
                        elapsed_ms=int(event.get("elapsed_ms") or elapsed_ms),
                    )
        else:
            for part in re.split(r"(\s+)", text):
                if part:
                    yield vryx_pb2.StreamChunk(event="token", token=part, elapsed_ms=elapsed_ms)

        done_payload = {
            "response": text,
            "pipeline_trace": trace,
            "prompt_tokens": int(response.prompt_tokens or 0),
            "completion_tokens": int(response.completion_tokens or 0),
            "total_tokens": int(response.total_tokens or 0),
            "vps_delegate_ms": int(response.vps_delegate_ms or 0),
            "compute_time_ms": int(response.compute_time_ms or 0),
            "shard_session_id": response.shard_session_id,
        }
        yield vryx_pb2.StreamChunk(
            event="done",
            json=json.dumps(done_payload, ensure_ascii=False),
            done=True,
            elapsed_ms=elapsed_ms,
        )


def _handle_legacy_shard(dtype: str, raw: bytes, session_id: str):
    """Compatibilité : ancien vryx.shard.* / vryx.tp.* / vryx.dist.*"""
    metrics = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
    eff_dtype = dtype
    if dtype.startswith("vryx.dist."):
        eff_dtype = "vryx.shard." + dtype[len("vryx.dist."):]
    elif dtype.startswith("vryx.tp."):
        eff_dtype = "vryx.shard." + dtype[len("vryx.tp."):]

    if eff_dtype == "vryx.shard.init":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        sid = session_id or str(meta.get("session_id") or "")
        msg = shard_runtime.shard_init(sid, int(meta.get("ttl_sec") or 600),
                                        int(meta.get("layer_start") or 0),
                                        int(meta.get("layer_end") or 0),
                                        str(meta.get("model_tag") or ""))
        return msg, metrics, sid, 0, 0

    if eff_dtype == "vryx.shard.load":
        # Déléguer au nouveau pipeline_shard_load
        result_str = shard_runtime.pipeline_shard_load(raw)
        sid = session_id
        try:
            sid = json.loads(raw.decode()).get("session_id", sid) or sid
        except Exception:
            pass
        return result_str, metrics, sid, 0, 0

    if eff_dtype in ("vryx.shard.forward", "vryx.pipeline.forward"):
        t0 = time.perf_counter()
        out, compute_ms = shard_runtime.ephemeral_layer_forward(raw, 0, session_id)
        return out, metrics, session_id, 0, compute_ms

    if eff_dtype == "vryx.shard.unload":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        sid = session_id or str(meta.get("session_id") or "")
        msg = shard_runtime.shard_unload(sid)
        return msg, metrics, sid, 0, 0

    return "", metrics, "", 0, 0


# ── Serve ──────────────────────────────────────────────────────────────────────

async def serve(port: int, stage: int):
    # Limite 1 GB pour les transferts de poids de modèle (Pipeline Parallelism).
    _1GB = 1 * 1024 * 1024 * 1024
    server = grpc.aio.server(options=[
        ("grpc.max_receive_message_length", _1GB),
        ("grpc.max_send_message_length", _1GB),
        ("grpc.max_metadata_size", 16 * 1024),
    ])
    vryx_pb2_grpc.add_InferenceServiceServicer_to_server(
        InferenceService(stage),
        server,
    )
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50052)
    parser.add_argument("--stage", type=int, default=2,
                        help="1 = initiateur P2P, 2 = worker (couches gRPC)")
    parser.add_argument("--model", type=str, default="", help="Nom du modèle annoncé par le worker")
    parser.add_argument("--layers", type=str, default="")
    parser.add_argument("--remote-url", type=str, default="")
    parser.add_argument("--device", type=str, default=None)
    args = parser.parse_args()
    if args.model:
        os.environ["VRYX_WORKER_MODEL"] = args.model
    asyncio.run(serve(args.port, args.stage))
