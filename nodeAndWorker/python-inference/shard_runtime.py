"""
Worker-side Pipeline Parallelism — Vryx DePIN.

Chaque worker reçoit :
  1. vryx.shard.init   → métadonnées (couches à exécuter, config modèle)
  2. vryx.shard.load   → tranches de poids (float16 numpy, envoyées par le VPS)
  3. vryx.shard.forward → hidden_states (float16 bytes) ou token_ids JSON (1er worker)

Le VPS garde le modèle complet. Les workers n'ont JAMAIS besoin de télécharger quoi
que ce soit depuis HuggingFace : ils reçoivent les poids nécessaires depuis le VPS.

Sortie du dernier worker : JSON {"next_token_id": <int>}
Sortie des workers intermédiaires : bytes float16 = hidden_states
"""
from __future__ import annotations

import base64
import json
import os
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import urllib.request
import numpy as np
import torch
import torch.nn.functional as F

warnings.filterwarnings("ignore")

# ── Imports transformers (architecture uniquement, pas de poids HF) ────────────
try:
    from transformers import Qwen2Config, GPT2Config
    from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer, Qwen2RMSNorm
    try:
        from transformers.models.qwen2.modeling_qwen2 import Qwen2RotaryEmbedding
    except ImportError:
        Qwen2RotaryEmbedding = None
    from transformers.models.gpt2.modeling_gpt2 import GPT2Block
    try:
        from transformers.cache_utils import DynamicCache
        _HAS_DYNAMIC_CACHE = True
    except ImportError:
        _HAS_DYNAMIC_CACHE = False
    HAS_QWEN2 = True
    HAS_GPT2 = True
except ImportError as _te:
    HAS_QWEN2 = False
    HAS_GPT2 = False
    _HAS_DYNAMIC_CACHE = False
    Qwen2RotaryEmbedding = None


# ── Session ────────────────────────────────────────────────────────────────────

@dataclass
class PipelineShard:
    session_id: str
    layer_start: int
    layer_end: int
    model_config: dict
    has_embedding: bool
    has_lm_head: bool
    hidden_size: int
    vocab_size: int
    ttl_sec: int
    created_ns: int
    # Poids reçus (name → np.ndarray float16)
    weight_arrays: Dict[str, np.ndarray] = field(default_factory=dict)
    # Slice PyTorch construit après réception des poids
    model_slice: Optional[Any] = None
    # KV cache (DynamicCache ou list of (k, v) tensors)
    kv_cache: Optional[Any] = None
    # Position courante dans la séquence (pour RoPE)
    seq_position: int = 0


_shards: Dict[str, PipelineShard] = {}


def _now_ns() -> int:
    return time.time_ns()


def _purge_expired() -> None:
    now = _now_ns()
    dead = [
        sid for sid, s in _shards.items()
        if now - s.created_ns > int(s.ttl_sec) * 1_000_000_000
    ]
    for sid in dead:
        s = _shards.pop(sid, None)
        if s and s.model_slice is not None:
            del s.model_slice
            s.model_slice = None
            s.kv_cache = None


# ── Ancien runtime (compatibilité descendante) ─────────────────────────────────

@dataclass
class EphemeralShardSession:
    session_id: str
    layer_start: int
    layer_end: int
    created_ns: int
    ttl_sec: int
    model_tag: str = ""
    kv_cache: Any = None


_sessions: dict = {}


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
    return f"ok init {session_id} layers {layer_start}-{layer_end}"


def shard_unload(session_id: str) -> str:
    _sessions.pop(session_id, None)
    s = _shards.pop(session_id, None)
    if s and s.model_slice is not None:
        del s.model_slice
    return f"ok unload {session_id}"


def ephemeral_layer_forward(activation_bytes: bytes, layer_id: int, session_id: str) -> tuple[bytes, int]:
    """Fallback shard forward — retourne les bytes tels quels avec compute fictif."""
    t0 = time.perf_counter()
    if not activation_bytes:
        out = np.zeros(1, dtype=np.float16).tobytes()
    else:
        try:
            arr = np.frombuffer(activation_bytes, dtype=np.float16).copy()
            out = (arr * 1.0).tobytes()  # identité
        except Exception:
            out = activation_bytes
    compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
    return out, compute_ms


# ── Pipeline Parallelism ────────────────────────────────────────────────────────

class _Qwen2WorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.config = config
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.embed_tokens = torch.nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = torch.nn.ModuleList([
            Qwen2DecoderLayer(config, layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.norm = Qwen2RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        # Rotary embeddings (transformers 5.x : RoPE pré-calculé hors des couches)
        if Qwen2RotaryEmbedding is not None:
            self.rotary_emb = Qwen2RotaryEmbedding(config=config)
        else:
            self.rotary_emb = None


class _GPT2WorkerSlice(torch.nn.Module):
    def __init__(self, config, layer_start, layer_end, has_embedding, has_lm_head):
        super().__init__()
        self.has_embedding = has_embedding
        self.has_lm_head = has_lm_head
        if has_embedding:
            self.wte = torch.nn.Embedding(config.vocab_size, config.n_embd)
            self.wpe = torch.nn.Embedding(config.n_positions, config.n_embd)
            self.drop = torch.nn.Dropout(config.embd_pdrop)
        self.h = torch.nn.ModuleList([
            GPT2Block(config, layer_idx=layer_start + i)
            for i in range(layer_end - layer_start + 1)
        ])
        if has_lm_head:
            self.ln_f = torch.nn.LayerNorm(config.n_embd, eps=config.layer_norm_epsilon)
            self.lm_head = torch.nn.Linear(config.n_embd, config.vocab_size, bias=False)


def _build_slice(shard: PipelineShard) -> object:
    """Construit le module PyTorch depuis les poids reçus."""
    cfg_d = shard.model_config
    model_type = cfg_d.get("model_type", "gpt2")

    # Utiliser float32 pour la précision (float16 provoque des dégénérescences dans GPT-2)
    state_dict = {k: torch.from_numpy(v.copy()).to(torch.float32)
                  for k, v in shard.weight_arrays.items()}

    if model_type == "gpt2" and HAS_GPT2:
        config = GPT2Config(
            n_embd=cfg_d.get("n_embd", 768),
            n_layer=cfg_d.get("n_layer", 12),
            n_head=cfg_d.get("n_head", 12),
            n_positions=cfg_d.get("n_positions", 1024),
            vocab_size=cfg_d.get("vocab_size", 50257),
            layer_norm_epsilon=float(cfg_d.get("layer_norm_epsilon", 1e-5)),
            embd_pdrop=float(cfg_d.get("embd_pdrop", 0.1)),
            resid_pdrop=0.0,
            attn_pdrop=0.0,
        )
        model = _GPT2WorkerSlice(
            config, shard.layer_start, shard.layer_end,
            shard.has_embedding, shard.has_lm_head,
        )
    elif HAS_QWEN2:
        config = Qwen2Config(
            hidden_size=cfg_d.get("hidden_size", 896),
            num_hidden_layers=cfg_d.get("num_hidden_layers_total", 24),
            num_attention_heads=cfg_d.get("num_attention_heads", 14),
            num_key_value_heads=cfg_d.get("num_key_value_heads", 2),
            intermediate_size=cfg_d.get("intermediate_size", 4864),
            vocab_size=cfg_d.get("vocab_size", 151936),
            rms_norm_eps=float(cfg_d.get("rms_norm_eps", 1e-6)),
            rope_theta=float(cfg_d.get("rope_theta", 1000000.0)),
            max_position_embeddings=int(cfg_d.get("max_position_embeddings", 32768)),
        )
        model = _Qwen2WorkerSlice(
            config, shard.layer_start, shard.layer_end,
            shard.has_embedding, shard.has_lm_head,
        )
    else:
        raise RuntimeError("Aucune architecture transformers disponible.")

    missing, _ = model.load_state_dict(state_dict, strict=False)
    if missing:
        print(f"[!] Shard {shard.session_id}: {len(missing)} poids manquants ({missing[:3]}…)")

    model.eval()
    return model


def _is_gpt2(shard: PipelineShard) -> bool:
    return shard.model_config.get("model_type", "gpt2") == "gpt2"


# ── API principale ─────────────────────────────────────────────────────────────

def pipeline_shard_init(meta_json: bytes) -> str:
    """
    Reçoit vryx.shard.init.
    Si `download_url` est présent, télécharge les poids directement depuis le VPS (HTTPS),
    sans passer par le relay P2P (évite la limite de 1GB des circuits relay libp2p).
    """
    _purge_expired()
    meta = json.loads(meta_json.decode("utf-8", errors="replace"))
    sid = str(meta.get("session_id") or "")
    if not sid:
        return '{"ok": false, "error": "session_id manquant"}'
    cfg = meta.get("model_config") or {}
    hidden = int(cfg.get("hidden_size", 896))
    vocab = int(cfg.get("vocab_size", 151936))
    _shards[sid] = PipelineShard(
        session_id=sid,
        layer_start=int(meta.get("layer_start", 0)),
        layer_end=int(meta.get("layer_end", 7)),
        model_config=cfg,
        has_embedding=bool(meta.get("has_embedding", False)),
        has_lm_head=bool(meta.get("has_lm_head", False)),
        hidden_size=hidden,
        vocab_size=vocab,
        ttl_sec=int(meta.get("ttl_sec", 600)),
        created_ns=_now_ns(),
    )
    n_layers = _shards[sid].layer_end - _shards[sid].layer_start + 1
    print(f"[shard] init {sid[:16]}… layers {_shards[sid].layer_start}-{_shards[sid].layer_end}"
          f" embed={_shards[sid].has_embedding} lm_head={_shards[sid].has_lm_head}")

    # Téléchargement direct des poids depuis le VPS (HTTPS) si URL fournie
    download_url = str(meta.get("download_url") or "").strip()
    if download_url:
        try:
            import ssl as _ssl
            _ctx = _ssl.create_default_context()
            _ctx.check_hostname = False
            _ctx.verify_mode = _ssl.CERT_NONE
            print(f"[shard] Téléchargement manifeste depuis {download_url}")
            t0 = time.perf_counter()
            req = urllib.request.Request(download_url, method="GET")
            with urllib.request.urlopen(req, timeout=120, context=_ctx) as resp:
                raw = resp.read()
            shard_data = json.loads(raw.decode("utf-8", errors="replace"))

            shard = _shards[sid]
            n_weights = 0

            # Format binaire compact (manifest .json + .bin séparé) avec download chunké + retry
            bin_url = shard_data.get("binary_url")
            weights_index = shard_data.get("weights_index") or []
            if bin_url and weights_index:
                expected = int(shard_data.get("binary_total_bytes", 0))
                print(f"[shard] Téléchargement binaire depuis {bin_url} ({expected / 1e6:.1f} MB)")

                # Download par chunks avec retry + range requests si coupure
                bin_data = bytearray()
                bytes_read = 0
                max_retries = 5
                for attempt in range(max_retries):
                    try:
                        req_bin = urllib.request.Request(bin_url, method="GET")
                        if bytes_read > 0:
                            req_bin.add_header("Range", f"bytes={bytes_read}-")
                        with urllib.request.urlopen(req_bin, timeout=300, context=_ctx) as resp_bin:
                            while True:
                                chunk = resp_bin.read(4 * 1024 * 1024)  # 4 MB par chunk
                                if not chunk:
                                    break
                                bin_data.extend(chunk)
                                bytes_read += len(chunk)
                        if expected and bytes_read >= expected:
                            break
                        if not expected:
                            break
                        print(f"[shard] Reprise download (lu {bytes_read}/{expected})…")
                    except Exception as ex:
                        if attempt == max_retries - 1:
                            raise
                        print(f"[shard] Erreur download (tentative {attempt+1}) : {ex} — retry…")
                        time.sleep(2.0)

                bin_data = bytes(bin_data)
                if expected and len(bin_data) < expected:
                    raise RuntimeError(f"Download incomplet : {len(bin_data)}/{expected}")

                for entry in weights_index:
                    name = entry["name"]
                    shape = tuple(int(x) for x in entry["shape"])
                    dtype = np.dtype(entry["dtype"])
                    off = int(entry["offset"])
                    nbytes = int(entry["nbytes"])
                    arr = np.frombuffer(bytes(bin_data[off:off + nbytes]), dtype=dtype).reshape(shape).copy()
                    shard.weight_arrays[name] = arr
                    n_weights += 1
            else:
                # Compatibilité descendante : ancien format JSON+base64
                weights_meta = shard_data.get("weights") or {}
                for param_name, w in weights_meta.items():
                    try:
                        arr_bytes = base64.b64decode(w["b64"])
                        shape = tuple(int(x) for x in w["shape"])
                        dtype = np.dtype(w["dtype"])
                        arr = np.frombuffer(arr_bytes, dtype=dtype).reshape(shape).copy()
                        shard.weight_arrays[param_name] = arr
                        n_weights += 1
                    except Exception as e:
                        print(f"[shard] Erreur param {param_name} : {e}")

            elapsed = int((time.perf_counter() - t0) * 1000)
            print(f"[shard] Téléchargement OK : {n_weights} poids en {elapsed}ms")

            # Build immédiat
            build_res = json.loads(pipeline_shard_build(sid))
            if build_res.get("ok"):
                return json.dumps({"ok": True, "session_id": sid, "num_layers": n_layers,
                                   "weights_loaded": n_weights, "download_ms": elapsed})
            else:
                return json.dumps({"ok": False, "session_id": sid,
                                   "error": f"Build échoué : {build_res.get('error')}"})
        except Exception as e:
            print(f"[shard] Échec téléchargement {download_url} : {e}")
            return json.dumps({"ok": False, "session_id": sid, "error": f"Téléchargement échoué : {e}"})

    return json.dumps({"ok": True, "session_id": sid, "num_layers": n_layers})


def pipeline_shard_load(load_json: bytes) -> str:
    """Reçoit vryx.shard.load : accumule un paramètre (numpy float16)."""
    meta = json.loads(load_json.decode("utf-8", errors="replace"))
    sid = str(meta.get("session_id") or "")
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue"})
    param_name = str(meta.get("param_name", ""))
    shape = tuple(int(x) for x in meta.get("shape", []))
    dtype_str = str(meta.get("dtype", "float16"))
    data_b64 = meta.get("data_b64", "")
    raw = base64.b64decode(data_b64)
    dtype = np.dtype(dtype_str)
    arr = np.frombuffer(raw, dtype=dtype).reshape(shape).copy()
    shard.weight_arrays[param_name] = arr
    return json.dumps({"ok": True, "param": param_name, "shape": list(shape)})


def pipeline_shard_build(sid: str) -> str:
    """Construit le slice PyTorch après réception de tous les poids."""
    shard = _shards.get(sid)
    if shard is None:
        return json.dumps({"ok": False, "error": "session inconnue"})
    if not HAS_QWEN2:
        return json.dumps({"ok": False, "error": "transformers Qwen2 non disponible"})
    t0 = time.perf_counter()
    try:
        shard.model_slice = _build_slice(shard)
        elapsed = int((time.perf_counter() - t0) * 1000)
        n_params = sum(p.numel() for p in shard.model_slice.parameters())
        print(f"[shard] build {sid[:16]}… {n_params:,} params en {elapsed}ms")
        return json.dumps({"ok": True, "params": n_params, "build_ms": elapsed})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


def pipeline_shard_forward(data: bytes, session_id: str) -> bytes:
    """
    Exécute le forward sur la tranche de couches.

    Entrée (worker 1 — has_embedding) : JSON {"session_id", "token_ids", "step"}
    Entrée (workers 2+) : JSON {"session_id", "hidden_b64", "seq_pos", "step"}

    Sortie (dernier worker — has_lm_head) : JSON {"next_token_id", "session_id"}
    Sortie (workers intermédiaires) : JSON {"hidden_b64", "seq_pos", "step", "session_id"}
    """
    t0 = time.perf_counter()
    try:
        payload = json.loads(data.decode("utf-8", errors="replace"))
    except Exception:
        return json.dumps({"ok": False, "error": "payload JSON invalide"}).encode()

    sid = payload.get("session_id", session_id) or session_id
    shard = _shards.get(sid)

    if shard is None:
        return json.dumps({"ok": False, "error": f"session {sid[:16]} inconnue. Relancer shard.init+load."}).encode()

    # Construire le modèle si pas encore fait
    if shard.model_slice is None:
        build_result = pipeline_shard_build(sid)
        br = json.loads(build_result)
        if not br.get("ok"):
            return json.dumps({"ok": False, "error": f"Build échoué : {br.get('error')}"}).encode()

    model = shard.model_slice
    step = int(payload.get("step", 0))
    seq_pos = int(payload.get("seq_pos", 0))

    with torch.no_grad():
        is_gpt2 = _is_gpt2(shard)

        # ── Obtenir hidden_states ──────────────────────────────────────────────
        if shard.has_embedding and "token_ids" in payload:
            token_ids = torch.tensor(payload["token_ids"], dtype=torch.long)
            if is_gpt2:
                pos = torch.arange(seq_pos, seq_pos + len(token_ids), dtype=torch.long)
                tok_emb = model.wte(token_ids).float()   # float32
                pos_emb = model.wpe(pos).float()          # float32
                hidden_states = (tok_emb + pos_emb).unsqueeze(0)
            else:
                hidden_states = model.embed_tokens(token_ids).float().unsqueeze(0)
            current_seq_len = len(token_ids)
        else:
            hidden_b64 = payload.get("hidden_b64", "")
            if not hidden_b64:
                return json.dumps({"ok": False, "error": "hidden_b64 manquant"}).encode()
            hs_bytes = base64.b64decode(hidden_b64)
            hs_flat = np.frombuffer(hs_bytes, dtype=np.float32)
            seq_len_inferred = len(hs_flat) // shard.hidden_size
            hidden_states = torch.from_numpy(hs_flat.copy())
            hidden_states = hidden_states.reshape(1, seq_len_inferred, shard.hidden_size)
            current_seq_len = seq_len_inferred

        # ── Masque causal additif (obligatoire pour attention décodeur) ───────
        seq_len_for_mask = hidden_states.shape[1]
        causal_mask = torch.full(
            (seq_len_for_mask, seq_len_for_mask), float("-inf"),
            dtype=hidden_states.dtype,
        )
        causal_mask = torch.triu(causal_mask, diagonal=1)
        causal_mask = causal_mask.unsqueeze(0).unsqueeze(0)  # (1, 1, seq, seq)

        # ── Position embeddings (Qwen2 transformers 5.x : RoPE pré-calculé) ───
        position_embeddings = None
        position_ids = None
        if not is_gpt2:
            position_ids = torch.arange(seq_pos, seq_pos + current_seq_len, dtype=torch.long).unsqueeze(0)
            if model.rotary_emb is not None:
                position_embeddings = model.rotary_emb(hidden_states, position_ids)

        # ── Passe à travers les couches ────────────────────────────────────────
        layers = model.h if is_gpt2 else model.layers
        for layer in layers:
            if is_gpt2:
                out = layer(hidden_states, attention_mask=causal_mask)
                if isinstance(out, torch.Tensor):
                    hidden_states = out
                else:
                    hidden_states = out[0]
            else:
                kwargs = {
                    "attention_mask": causal_mask,
                    "position_ids": position_ids,
                    "use_cache": False,
                }
                if position_embeddings is not None:
                    kwargs["position_embeddings"] = position_embeddings
                layer_out = layer(hidden_states, **kwargs)
                if isinstance(layer_out, torch.Tensor):
                    hidden_states = layer_out
                else:
                    hidden_states = layer_out[0]

        # Réassurer la dim batch pour l'extraction du dernier token
        if hidden_states.dim() == 2:
            # (seq_len, hidden_size) → (1, seq_len, hidden_size)
            hidden_states = hidden_states.unsqueeze(0)

        new_seq_pos = seq_pos + current_seq_len
        shard.seq_position = new_seq_pos
        compute_ms = max(1, int((time.perf_counter() - t0) * 1000))

        # ── Sortie ─────────────────────────────────────────────────────────────
        if shard.has_lm_head:
            # Dernier worker : LM head → next_token_id
            last_hidden = hidden_states[0, -1, :]  # (hidden_size,)
            if is_gpt2:
                last_normed = model.ln_f(last_hidden.unsqueeze(0))
                logits = model.lm_head(last_normed)
            else:
                last_normed = model.norm(last_hidden.unsqueeze(0))
                logits = model.lm_head(last_normed)
            next_token_id = int(torch.argmax(logits, dim=-1).item())
            print(f"[shard] lm_head {sid[:12]}… step={step} → token={next_token_id} ({compute_ms}ms)")
            return json.dumps({
                "ok": True,
                "next_token_id": next_token_id,
                "session_id": sid,
                "compute_time_ms": compute_ms,
            }).encode()
        else:
            # Worker intermédiaire : renvoyer hidden_states au hop suivant (float32)
            hs_out = hidden_states[0].float().cpu().numpy().flatten()
            hs_b64 = base64.b64encode(hs_out.tobytes()).decode()
            print(f"[shard] forward {sid[:12]}… step={step} seq_pos={new_seq_pos} ({compute_ms}ms)")
            return json.dumps({
                "ok": True,
                "hidden_b64": hs_b64,
                "seq_pos": new_seq_pos,
                "step": step,
                "session_id": sid,
                "compute_time_ms": compute_ms,
            }).encode()

    # Unreachable but satisfies type checker
    return json.dumps({"ok": False, "error": "unknown"}).encode()


def worker_text_relay(payload_bytes: bytes, routing_path: list) -> tuple[str, int]:
    """Fallback minimal — retourne un message d'erreur propre si aucune session active."""
    t0 = time.perf_counter()
    compute_ms = max(1, int((time.perf_counter() - t0) * 1000))
    msg = json.dumps({
        "ok": False,
        "error": "Aucune session de couches active sur ce worker. Lancer shard.init + shard.load.",
        "worker_generated_text": False,
    })
    return msg, compute_ms
