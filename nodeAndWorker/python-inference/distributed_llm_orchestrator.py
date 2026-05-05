"""
Orchestrateur distribué Vryx — fan-out multi-worker.

Stratégie actuelle (v2) :
  * Découvre les workers live via l'API Express interne (/api/internal/live-peers).
  * Envoie le prompt à N workers en parallèle via le relay P2P du daemon Rust.
  * Premier à répondre avec succès → sa réponse est utilisée.
  * Tous les temps de réponse et peer IDs sont tracés.

Évolution future (large models) :
  * Chaque worker chargera une tranche de couches du modèle (pipeline parallel).
  * Le prompt sera tokenisé sur le VPS, les hidden states passeront de worker en worker.
  * Ce module contiendra le séquençage des étapes.

Variables d'environnement :
  VRYX_P2P_RELAY_URL      URL du daemon Rust initiateur (défaut : http://127.0.0.1:3031)
  VRYX_DIST_MAX_WORKERS   Nombre max de workers contactés en parallèle (défaut : 3)
  VRYX_DIST_TIMEOUT_SEC   Timeout par worker (défaut : 90)
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed, Future
from typing import Any


# ─── Config ───────────────────────────────────────────────────────────────────

def _relay_url() -> str:
    return os.environ.get("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031").rstrip("/")


def _max_workers() -> int:
    return max(1, int(os.environ.get("VRYX_DIST_MAX_WORKERS", "3")))


def _timeout() -> float:
    return float(os.environ.get("VRYX_DIST_TIMEOUT_SEC", "90"))


# ─── Découverte des workers ────────────────────────────────────────────────────

def _discover_live_peers() -> list[str]:
    """Interroge l'API Express interne pour obtenir les peer IDs actifs."""
    # 1. Relay Rust /api/tp-peers (le plus direct)
    try:
        req = urllib.request.Request(
            f"{_relay_url()}/api/tp-peers", method="GET"
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        if j.get("ok") and isinstance(j.get("peers"), list):
            peers = [p for p in j["peers"] if isinstance(p, str) and p.strip()]
            if peers:
                return peers
    except Exception:
        pass

    # 2. API Express interne (fallback)
    for port in (48953, 4000):
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/internal/live-peers",
                method="GET",
                headers={"X-Internal-Token": "vryx-internal-localhost"},
            )
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                j = json.loads(resp.read().decode("utf-8"))
            if j.get("ok") and isinstance(j.get("peers"), list):
                peers = [p for p in j["peers"] if isinstance(p, str) and p.strip()]
                if peers:
                    return peers
        except Exception:
            continue

    return []


# ─── Relay P2P ─────────────────────────────────────────────────────────────────

def _relay_text(peer_id: str, prompt: str, timeout: float) -> dict[str, Any]:
    """Envoie le prompt en clair à un peer via le relay P2P du daemon Rust."""
    import base64
    url = f"{_relay_url()}/api/p2p/relay"
    payload = json.dumps({
        "target_peer": peer_id,
        "dtype": "text",
        "data_b64": base64.standard_b64encode(prompt.encode("utf-8")).decode("ascii"),
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        dt_ms = (time.perf_counter() - t0) * 1000.0
        j = json.loads(raw)
        return {"ok": j.get("ok", True), "peer": peer_id, "latency_ms": round(dt_ms, 1), "data": j}
    except urllib.error.HTTPError as e:
        dt_ms = (time.perf_counter() - t0) * 1000.0
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            body = str(e)
        return {"ok": False, "peer": peer_id, "latency_ms": round(dt_ms, 1), "error": f"HTTP {e.code}: {body}"}
    except Exception as ex:
        dt_ms = (time.perf_counter() - t0) * 1000.0
        return {"ok": False, "peer": peer_id, "latency_ms": round(dt_ms, 1), "error": str(ex)}


# ─── Fan-out multi-worker ───────────────────────────────────────────────────────

def run_distributed_chat(prompt: str) -> dict[str, Any]:
    """
    Envoie le prompt à N workers en parallèle.
    Premier à répondre avec succès → gagnant.
    Retourne un dict avec text, ok, metrics, trace.
    """
    peers = _discover_live_peers()
    if not peers:
        return {
            "ok": False,
            "text": "",
            "error": "Aucun worker P2P découvert.",
            "trace": {"layout": "distributed_fanout", "ok": False, "peers": [], "steps": []},
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": 0},
        }

    max_w = _max_workers()
    selected = peers[:max_w]
    timeout = _timeout()
    t_global = time.perf_counter()

    print(f"[DIST] Fan-out vers {len(selected)} workers : {selected}")

    winner_text = ""
    winner_peer = ""
    winner_latency = 0.0
    all_steps: list[dict] = []
    all_ok = False

    with ThreadPoolExecutor(max_workers=len(selected)) as ex:
        futures: dict[Future, str] = {
            ex.submit(_relay_text, peer, prompt, timeout): peer
            for peer in selected
        }
        for fut in as_completed(futures, timeout=timeout + 5):
            result = fut.result()
            all_steps.append({
                "peer": result["peer"],
                "latency_ms": result["latency_ms"],
                "ok": result["ok"],
                "error": result.get("error"),
            })
            if result["ok"] and not all_ok:
                # Extraire le texte de la réponse relay
                data = result.get("data", {})
                text = ""
                if isinstance(data, dict):
                    # Le relay peut renvoyer data_b64 (bytes) ou response (string)
                    if "data_b64" in data:
                        import base64
                        try:
                            raw = base64.standard_b64decode(data["data_b64"])
                            # Essayer de décoder comme JSON (réponse gRPC)
                            try:
                                inner = json.loads(raw.decode("utf-8", errors="replace"))
                                text = str(inner.get("response") or inner.get("text") or raw.decode("utf-8", errors="replace"))
                            except Exception:
                                text = raw.decode("utf-8", errors="replace")
                        except Exception:
                            pass
                    elif "response" in data:
                        text = str(data["response"])
                    elif "text" in data:
                        text = str(data["text"])

                if text.strip():
                    all_ok = True
                    winner_text = text.strip()
                    winner_peer = result["peer"]
                    winner_latency = result["latency_ms"]
                    print(f"[DIST] Gagnant : {winner_peer} ({winner_latency:.0f} ms)")
                    # Annuler les autres futures
                    for f in futures:
                        f.cancel()

    total_ms = round((time.perf_counter() - t_global) * 1000.0, 1)
    all_steps.sort(key=lambda s: s["latency_ms"])

    if not all_ok or not winner_text:
        return {
            "ok": False,
            "text": "",
            "error": "Tous les workers ont échoué ou n'ont pas renvoyé de texte.",
            "trace": {
                "layout": "distributed_fanout",
                "ok": False,
                "peers": selected,
                "steps": all_steps,
                "total_ms": total_ms,
            },
            "metrics": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "vps_delegate_ms": total_ms},
        }

    # Estimation tokens (grossière)
    prompt_toks = len(prompt.split())
    completion_toks = len(winner_text.split())
    return {
        "ok": True,
        "text": winner_text,
        "winner_peer": winner_peer,
        "trace": {
            "layout": "distributed_fanout",
            "ok": True,
            "peers": selected,
            "winner_peer": winner_peer,
            "steps": all_steps,
            "total_ms": total_ms,
            "metrics": {
                "prompt_tokens": prompt_toks,
                "completion_tokens": completion_toks,
                "total_tokens": prompt_toks + completion_toks,
                "vps_delegate_ms": round(winner_latency),
            },
        },
        "metrics": {
            "prompt_tokens": prompt_toks,
            "completion_tokens": completion_toks,
            "total_tokens": prompt_toks + completion_toks,
            "vps_delegate_ms": round(winner_latency),
        },
    }


def maybe_run_worker_only_chat(prompt: str) -> dict[str, Any] | None:
    """
    Appelé par inference_server.py quand VRYX_WORKER_ONLY_LLM=1.
    Utilise le fan-out distribué si des workers sont dispo,
    sinon renvoie None pour fallback Ollama.
    """
    peers = _discover_live_peers()
    if not peers:
        return None
    result = run_distributed_chat(prompt)
    # Normaliser la trace pour l'UI
    if result.get("trace"):
        result["trace"]["layout"] = "distributed_fanout"
    return result
