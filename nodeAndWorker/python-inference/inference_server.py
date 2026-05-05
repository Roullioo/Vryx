"""
Serveur gRPC d'inférence Vryx.

- Stage 1 (VPS / initiateur) : par défaut Ollama local (127.0.0.1:11434). Si
  `VRYX_WORKER_ONLY_LLM=1`, le texte est produit **uniquement** via les workers P2P
  (`distributed_llm_orchestrator.py`), sans appel Ollama.
- Stage 2 (worker sur machine d'un contributeur) : **aucun modèle local**. Les requêtes sont
  renvoyées au VPS via HTTP (`/api/workers/inference-delegate`) avec un secret partagé.
  Les PC des gens ne téléchargent ni n'exécutent le LLM localement.

Métriques : `prompt_tokens` / `completion_tokens` (Ollama) distinctes des messages P2P.

Runtime shard : dtypes `vryx.shard.*`, `vryx.tp.*` et `vryx.dist.*` (RAM, voir `shard_runtime.py`).
Tensor-parallel optionnel (stage 1) : `VRYX_TP_ENABLED`, `VRYX_P2P_RELAY_URL`,
`VRYX_TP_PEER_IDS` (optionnel) ; si vide, `GET …/api/tp-peers` sur le relais sauf
`VRYX_TP_USE_ALL_PEERS=0|false|no|off`. Découpe row-split : chaque worker reçoit
une bande de lignes de W (charge ~1/K).

Worker-only : `VRYX_WORKER_ONLY_LLM`, `VRYX_DIST_HIDDEN`, `VRYX_DIST_MAX_NEW_TOKENS`.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
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
import tensor_parallel_orchestrator


def _worker_only_llm_enabled() -> bool:
    return os.environ.get("VRYX_WORKER_ONLY_LLM", "").strip().lower() in ("1", "true", "yes", "on")


def _ollama_url() -> str:
    return os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


def _default_model(stage: int) -> str:
    env = os.environ.get("OLLAMA_MODEL", "").strip()
    if env:
        return env
    if stage == 1:
        return os.environ.get("OLLAMA_MODEL_STAGE1", "gemma3:2b")
    return os.environ.get("OLLAMA_MODEL_STAGE2", "gemma3:2b")


_VRYX_SYSTEM_PROMPT = (
    "Tu es Vryx, un assistant IA concis et direct. "
    "Réponds toujours dans la même langue que l'utilisateur. "
    "Sois précis, utile et ne répète jamais le préambule ni le contexte fourni."
)


def _ollama_generate_blocking(prompt: str, model: str) -> dict:
    """POST /api/chat (non stream) sur Ollama local — utilise le format instruct avec system prompt."""
    url = f"{_ollama_url()}/api/chat"
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": _VRYX_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            # /api/chat returns: {"message": {"role": "assistant", "content": "..."}, ...}
            msg = data.get("message") or {}
            text = (msg.get("content") or data.get("response") or "").strip()
            # token counts in /api/chat response
            pt = int(data.get("prompt_eval_count") or 0)
            ct = int(data.get("eval_count") or 0)
            total = pt + ct
            dur_ns = data.get("total_duration")
            vps_ms = int((dur_ns or 0) / 1_000_000) if isinstance(dur_ns, (int, float)) else 0
            return {
                "text": text,
                "prompt_tokens": pt,
                "completion_tokens": ct,
                "total_tokens": total,
                "vps_delegate_ms": vps_ms,
            }
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
        print(f"[!] Ollama local indisponible ({e}).")
        return {"text": "", "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}


def _delegate_generate_blocking(url: str, secret: str, prompt: str, model: str | None) -> dict:
    """Appelle le VPS : l'inférence est exécutée côté serveur uniquement."""
    body_obj: dict = {"prompt": prompt}
    if model:
        body_obj["model"] = model
    body = json.dumps(body_obj).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/"),
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Vryx-Inference-Delegate": secret,
        },
        method="POST",
    )

    def _parse_body(raw: bytes) -> dict:
        data = json.loads(raw.decode("utf-8"))
        if not data.get("ok", True) and data.get("error"):
            print(f"[!] Délégation refusée : {data.get('error')}")
            return {
                "text": "",
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "vps_delegate_ms": 0,
            }
        text = (data.get("response") or "").strip()
        pt = int(data.get("promptTokens") or data.get("prompt_tokens") or 0)
        ct = int(data.get("completionTokens") or data.get("completion_tokens") or 0)
        tt = int(data.get("totalTokens") or data.get("total_tokens") or (pt + ct))
        dns = data.get("vpsOllamaDurationNs") or data.get("vps_ollama_duration_ns")
        vps_ms = int((dns or 0) / 1_000_000) if isinstance(dns, (int, float)) else 0
        return {
            "text": text,
            "prompt_tokens": pt,
            "completion_tokens": ct,
            "total_tokens": tt,
            "vps_delegate_ms": vps_ms,
        }

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return _parse_body(resp.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
        except Exception:
            err_body = str(e)
        print(f"[!] Délégation HTTP {e.code}: {err_body[:500]}")
        return {"text": "", "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        if isinstance(reason, ssl.SSLError) and "CERTIFICATE_VERIFY_FAILED" in str(reason):
            print("[!] Certificat TLS non trouvé par Python macOS, retry vers vryx.eu.")
            try:
                insecure_ctx = ssl._create_unverified_context()
                with urllib.request.urlopen(req, timeout=300, context=insecure_ctx) as resp:
                    return _parse_body(resp.read())
            except Exception as retry_error:
                print(f"[!] Délégation TLS retry échouée ({retry_error}).")
                return {"text": "", "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
        print(f"[!] Délégation indisponible ({e}).")
        return {"text": "", "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
    except (TimeoutError, json.JSONDecodeError) as e:
        print(f"[!] Délégation indisponible ({e}).")
        return {"text": "", "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}


async def ollama_local_generate(prompt: str, model: str) -> dict:
    return await asyncio.to_thread(_ollama_generate_blocking, prompt, model)


async def delegate_generate(url: str, secret: str, prompt: str, model: str | None) -> dict:
    return await asyncio.to_thread(_delegate_generate_blocking, url, secret, prompt, model)


def _processed_from_text(
    text: str,
    start_ns: int,
    metrics: dict,
    shard_session_id: str = "",
    shard_layer_id: int = 0,
    pipeline_trace_json: str = "",
) -> vryx_pb2.ProcessedTensorData:
    return vryx_pb2.ProcessedTensorData(
        data=text.encode("utf-8"),
        compute_time_ns=time.perf_counter_ns() - start_ns,
        serialization_time_ns=0,
        prompt_tokens=int(metrics.get("prompt_tokens") or 0),
        completion_tokens=int(metrics.get("completion_tokens") or 0),
        total_tokens=int(metrics.get("total_tokens") or 0),
        vps_delegate_ms=int(metrics.get("vps_delegate_ms") or 0),
        shard_session_id=shard_session_id or "",
        shard_layer_id=int(shard_layer_id or 0),
        pipeline_trace_json=pipeline_trace_json or "",
    )


def _handle_shard_dtype(dtype: str, raw: bytes) -> tuple[str | bytes, dict, str, int]:
    """Retourne (texte trace ou bytes activations, métriques, session_id, layer_id)."""
    metrics = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
    session_id = ""
    layer_id = 0
    if dtype == "vryx.shard.init":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        session_id = str(meta.get("session_id") or "")
        msg = shard_runtime.shard_init(
            session_id,
            int(meta.get("ttl_sec") or 120),
            int(meta.get("layer_start") or 0),
            int(meta.get("layer_end") or 0),
            str(meta.get("model_tag") or ""),
        )
        return msg, metrics, session_id, 0
    if dtype == "vryx.shard.load":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        session_id = str(meta.get("session_id") or "")
        chunk_i = int(meta.get("chunk_index") or 0)
        chunk_tot = int(meta.get("chunk_total") or 1)
        payload = base64.b64decode(meta.get("payload_b64") or "")
        msg = shard_runtime.shard_load_chunk(session_id, chunk_i, chunk_tot, payload)
        return msg, metrics, session_id, 0
    if dtype == "vryx.shard.forward":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        session_id = str(meta.get("session_id") or "")
        layer_id = int(meta.get("layer_id") or 0)
        act = base64.b64decode(meta.get("activation_b64") or "")
        out = shard_runtime.ephemeral_layer_forward(act, layer_id, session_id)
        return out, metrics, session_id, layer_id
    if dtype == "vryx.shard.unload":
        meta = json.loads(raw.decode("utf-8", errors="replace"))
        session_id = str(meta.get("session_id") or "")
        msg = shard_runtime.shard_unload(session_id)
        return msg, metrics, session_id, 0
    return "", metrics, "", 0


class InferenceService(vryx_pb2_grpc.InferenceServiceServicer):
    def __init__(self, stage: int, delegate_url: str, delegate_secret: str):
        self.stage = stage
        self.delegate_url = delegate_url.strip()
        self.delegate_secret = delegate_secret.strip()
        self.model = _default_model(stage)

        if stage == 1:
            print(
                f"[*] Stage 1 (VPS) — Ollama local {_ollama_url()} — modèle {self.model}. "
                "Aucun appel sortant pour l'inférence."
            )
        else:
            if not self.delegate_url or not self.delegate_secret:
                print(
                    "[!] Stage 2 (worker) : définissez --delegate-url et --delegate-secret "
                    "(ou VRYX_INFERENCE_DELEGATE_URL / VRYX_INFERENCE_DELEGATE_SECRET). "
                    "L'inférence doit rester sur le VPS."
                )
            else:
                print(
                    f"[*] Stage 2 (worker) — délégation vers {self.delegate_url} "
                    "(modèle exécuté uniquement sur le VPS, pas sur ce poste)."
                )

    async def ReportCapabilities(self, request, context):
        ram = int(request.ram_available_mb or 0)
        _ = request.backend_device
        return vryx_pb2.CapabilitiesAck(
            ok=True,
            message=f"capabilities_ok ram_mb={ram} runtime=vryx-python",
        )

    async def PingShardRuntime(self, request, context):
        start = time.perf_counter_ns()
        sid = request.session_id or "ping"
        msg = shard_runtime.shard_init(
            sid,
            int(request.ttl_sec or 60),
            int(request.layer_start),
            int(request.layer_end),
            request.model_tag or "",
        )
        return vryx_pb2.ProcessedTensorData(
            data=msg.encode("utf-8"),
            compute_time_ns=time.perf_counter_ns() - start,
            serialization_time_ns=0,
            shard_session_id=sid,
        )

    async def Process(self, request, context):
        start = time.perf_counter_ns()
        dtype = getattr(request, "dtype", "unknown") or "unknown"
        raw = bytes(request.data) if request.data else b""

        eff_dtype = dtype
        eff_raw = raw
        if dtype.startswith("vryx.dist."):
            eff_dtype = "vryx.shard." + dtype[len("vryx.dist.") :]
            if eff_dtype == "vryx.shard.init":
                try:
                    meta = json.loads(raw.decode("utf-8", errors="replace"))
                    meta.setdefault("model_tag", "vryx.dist")
                    eff_raw = json.dumps(meta).encode("utf-8")
                except Exception:
                    eff_raw = raw
        elif dtype.startswith("vryx.tp."):
            eff_dtype = "vryx.shard." + dtype[len("vryx.tp.") :]
            if eff_dtype == "vryx.shard.init":
                try:
                    meta = json.loads(raw.decode("utf-8", errors="replace"))
                    meta.setdefault("model_tag", "vryx.tp")
                    eff_raw = json.dumps(meta).encode("utf-8")
                except Exception:
                    eff_raw = raw

        if eff_dtype.startswith("vryx.shard."):
            try:
                out_payload, metrics, sid, lid = _handle_shard_dtype(eff_dtype, eff_raw)
            except Exception as e:
                out_payload = f"[vryx.shard] erreur : {e}"
                metrics = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
                sid, lid = "", 0
            print(f"[>] Shard dtype={dtype} session={sid!r} layer={lid}")
            if isinstance(out_payload, bytes):
                return vryx_pb2.ProcessedTensorData(
                    data=out_payload,
                    compute_time_ns=time.perf_counter_ns() - start,
                    serialization_time_ns=0,
                    prompt_tokens=0,
                    completion_tokens=0,
                    total_tokens=0,
                    vps_delegate_ms=0,
                    shard_session_id=sid or "",
                    shard_layer_id=int(lid or 0),
                )
            return _processed_from_text(str(out_payload), start, metrics, shard_session_id=sid, shard_layer_id=lid)

        if dtype == "text":
            try:
                prompt = raw.decode("utf-8", errors="replace")
            except Exception:
                prompt = ""
        else:
            try:
                inner = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                inner = ""
            prompt = (
                "Tu es un assistant. À partir du contexte suivant (sortie intermédiaire du réseau), "
                "produis une courte continuation utile en français, sans répéter le préambule.\n\n"
                f"Contexte :\n{inner}\n\nRéponse :"
            )

        print(f"[>] Requête (dtype={dtype}, stage={self.stage}), {len(raw)} octets.")

        pipeline_trace_json = ""

        if self.stage == 1:
            worker_only = _worker_only_llm_enabled()

            # 1. Génération du texte (Ollama VPS par défaut)
            if not worker_only:
                ollama_result = await ollama_local_generate(prompt, self.model)
                text_out = ollama_result.get("text") or "[Vryx] Ollama local indisponible."
                metrics = {k: int(ollama_result.get(k) or 0) for k in ("prompt_tokens", "completion_tokens", "total_tokens", "vps_delegate_ms")}
            else:
                text_out = ""
                metrics = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}

            # 2. Tensor Parallelism (découpe de matrice sur les workers)
            # Exécuté en arrière-plan pour ne pas bloquer l'event loop
            def _run_tp():
                return tensor_parallel_orchestrator.maybe_run_tensor_parallel()

            tp_future = asyncio.get_event_loop().run_in_executor(None, _run_tp)
            try:
                # On attend le TP avec un timeout de 15s
                tp_result = await asyncio.wait_for(tp_future, timeout=16.0)
                if tp_result is not None:
                    if metrics:
                        tp_result["metrics"] = metrics
                    pipeline_trace_json = json.dumps(tp_result, ensure_ascii=False)
            except Exception as e:
                print(f"[!] Erreur ou timeout Tensor Parallel : {e}")
                pipeline_trace_json = json.dumps({
                    "layout": "row_split_tensor_parallel",
                    "ok": False,
                    "error": f"Timeout ou erreur TP: {e}",
                    "steps": [],
                    "metrics": metrics
                }, ensure_ascii=False)

            if worker_only and not text_out:
                text_out = "[Vryx] worker-only : texte généré par TP (simulation)."

        else:
            if not self.delegate_url or not self.delegate_secret:
                text_out = (
                    "[Vryx] Worker mal configuré : délégation VPS manquante "
                    "(VRYX_INFERENCE_DELEGATE_URL / SECRET). Aucun modèle ne doit tourner ici."
                )
                metrics = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0}
            else:
                metrics = await delegate_generate(
                    self.delegate_url,
                    self.delegate_secret,
                    prompt,
                    None,
                )
                text_out = metrics.get("text") or ""
                if not text_out:
                    text_out = (
                        "[Vryx] La délégation vers le VPS a échoué. Vérifiez le secret, "
                        "l'URL et Ollama sur le serveur."
                    )

        print(f"[>] Réponse ({len(text_out)} caractères), tokens LLM in/out={metrics.get('prompt_tokens')}/{metrics.get('completion_tokens')}.")

        return _processed_from_text(
            text_out,
            start,
            metrics,
            pipeline_trace_json=pipeline_trace_json,
        )


async def serve(port: int, stage: int, delegate_url: str, delegate_secret: str):
    server = grpc.aio.server()
    vryx_pb2_grpc.add_InferenceServiceServicer_to_server(
        InferenceService(stage, delegate_url, delegate_secret),
        server,
    )
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50052)
    parser.add_argument(
        "--stage",
        type=int,
        default=2,
        help="1 = VPS (Ollama local uniquement), 2 = worker (délégation HTTP vers le VPS)",
    )
    parser.add_argument("--model", type=str, default="", help="Surcharge OLLAMA_MODEL si renseigné")
    parser.add_argument("--delegate-url", type=str, default="", help="URL https://…/api/workers/inference-delegate")
    parser.add_argument("--delegate-secret", type=str, default="", help="Même valeur que WORKER_INFERENCE_DELEGATE_SECRET sur le VPS")
    parser.add_argument("--layers", type=str, default="")
    parser.add_argument("--remote-url", type=str, default="")
    parser.add_argument("--device", type=str, default=None)
    args = parser.parse_args()
    if args.model:
        os.environ["OLLAMA_MODEL"] = args.model

    d_url = (
        args.delegate_url
        or os.environ.get("VRYX_INFERENCE_DELEGATE_URL", "").strip()
    )
    d_secret = (
        args.delegate_secret
        or os.environ.get("VRYX_INFERENCE_DELEGATE_SECRET", "").strip()
    )

    asyncio.run(serve(args.port, args.stage, d_url, d_secret))
