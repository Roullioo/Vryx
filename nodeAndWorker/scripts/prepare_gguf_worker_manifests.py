#!/usr/bin/env python3
"""Prépare des manifests de shards workers depuis un GGUF local.

Le VPS ne charge pas le modèle: il lit seulement l'index GGUF, expose le fichier
source via hardlink/symlink dans VRYX_SHARD_BASE_DIR, puis écrit un manifeste par
worker contenant uniquement les ranges d'octets à télécharger.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path
from urllib.parse import quote

try:
    import gguf  # type: ignore
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"[ERR] module gguf manquant: {exc}")


GIB = 1024**3


def _safe_rel(value: str) -> str:
    rel = value.strip().replace("\\", "/").lstrip("/")
    if not rel or rel.startswith("../") or "/../" in rel:
        raise ValueError(f"chemin relatif invalide: {value!r}")
    return rel


def _stage_source(source: Path, shard_base: Path, rel: str) -> Path:
    rel = _safe_rel(rel)
    dst = shard_base / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return dst
    try:
        os.link(source, dst)
    except OSError:
        os.symlink(source, dst)
    return dst


def _layer_index(name: str) -> int | None:
    match = re.match(r"blk\.(\d+)\.", name)
    return int(match.group(1)) if match else None


def _tensor_bytes(tensor: object) -> int:
    return int(getattr(tensor, "n_bytes"))


def _gb(byte_count: int | float) -> float:
    return round(float(byte_count) / GIB, 3)


def _to_int(value: object, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _env_truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _worker_is_m1(worker: dict) -> bool:
    text = " ".join(
        str(worker.get(key) or "")
        for key in ("peer_id", "gpu_name", "model")
    ).lower()
    return "m1" in text or "apple m1" in text


def _read_json_arg(value: str) -> object:
    src = value.strip()
    if src.startswith("@"):
        return json.loads(Path(src[1:]).expanduser().read_text(encoding="utf-8"))
    if src.startswith("{") or src.startswith("["):
        return json.loads(src)
    maybe_path = Path(src).expanduser()
    if maybe_path.exists():
        return json.loads(maybe_path.read_text(encoding="utf-8"))
    return json.loads(src)


def _fetch_json(url: str, timeout: float = 10.0) -> object:
    headers = {}
    secret = os.environ.get("VRYX_WORKER_SECRET") or os.environ.get("WORKER_SECRET") or ""
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers, method="GET"), timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _normalize_workers(raw: object | None, fallback_count: int, default_worker_gb: float) -> list[dict]:
    workers_raw: object = raw or []
    if isinstance(workers_raw, dict):
        workers_raw = workers_raw.get("workers") or workers_raw.get("data") or []
    workers: list[dict] = []
    if isinstance(workers_raw, list):
        for idx, item in enumerate(workers_raw):
            if not isinstance(item, dict):
                continue
            mode = str(item.get("mode") or "worker").lower()
            if mode and mode != "worker":
                continue
            peer_id = str(item.get("peerId") or item.get("peer_id") or f"worker-{idx}")
            gpu_vram_mb = _to_int(item.get("gpuVramMb") or item.get("gpu_vram_mb"))
            allocated_vram_mb = _to_int(item.get("allocatedVramMb") or item.get("allocated_vram_mb"))
            if allocated_vram_mb <= 0:
                allocated_vram_mb = gpu_vram_mb
            if allocated_vram_mb <= 0 and default_worker_gb > 0:
                allocated_vram_mb = int(default_worker_gb * 1024)
            workers.append(
                {
                    "peer_id": peer_id,
                    "gpu_name": item.get("gpuName") or item.get("gpu_name"),
                    "model": item.get("model"),
                    "gpu_vram_mb": gpu_vram_mb or None,
                    "allocated_vram_mb": allocated_vram_mb or None,
                    "memory_limit_percent": _to_int(item.get("memoryLimitPercent") or item.get("memory_limit_percent")) or None,
                    "backend": item.get("backend") or item.get("runtimeBackend") or item.get("runtime_backend"),
                    "model_format": item.get("model_format") or item.get("format"),
                    "local_model_path": item.get("local_model_path") or item.get("localModelPath"),
                    "layer_ms": item.get("layerMs") or item.get("layer_ms"),
                    "tokens_per_sec": item.get("tokensPerSec") or item.get("tokens_per_sec") or item.get("tps"),
                    "perf_score": item.get("perfScore") or item.get("perf_score"),
                    "source": "status",
                }
            )
    if workers:
        return workers
    return [
        {
            "peer_id": f"worker-{rank}",
            "gpu_name": None,
            "model": None,
            "gpu_vram_mb": None,
            "allocated_vram_mb": int(default_worker_gb * 1024) if default_worker_gb > 0 else None,
            "memory_limit_percent": None,
            "backend": None,
            "model_format": None,
            "local_model_path": None,
            "layer_ms": None,
            "tokens_per_sec": None,
            "perf_score": None,
            "source": "static",
        }
        for rank in range(max(1, fallback_count))
    ]


def _merge_worker_perf(workers: list[dict], raw: object | None) -> list[dict]:
    if raw is None:
        return workers
    items = raw.get("workers") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise SystemExit("[ERR] --worker-perf-json doit contenir une liste ou {workers:[...]}")
    by_peer: dict[str, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        peer_id = str(item.get("peer_id") or item.get("peerId") or item.get("target_peer_id") or "").strip()
        if peer_id:
            by_peer[peer_id] = item
    merged: list[dict] = []
    for worker in workers:
        out = dict(worker)
        peer_id = str(worker.get("peer_id") or "")
        perf = by_peer.get(peer_id)
        if perf:
            for dst, *srcs in [
                ("layer_ms", "layer_ms", "layerMs"),
                ("tokens_per_sec", "tokens_per_sec", "tokensPerSec", "tps"),
                ("perf_score", "perf_score", "perfScore"),
            ]:
                for src in srcs:
                    if perf.get(src) not in (None, ""):
                        out[dst] = perf.get(src)
                        break
        merged.append(out)
    return merged


def _usable_bytes(worker: dict, safety_gb: float, target_fill: float) -> int | None:
    allocated_mb = _to_int(worker.get("allocated_vram_mb"))
    if allocated_mb <= 0:
        return None
    usable_gb = max(0.0, allocated_mb / 1024.0 - max(0.0, safety_gb))
    return max(0, int(usable_gb * GIB * max(0.05, min(1.0, target_fill))))


def _order_workers_for_pipeline(workers: list[dict], safety_gb: float, target_fill: float) -> list[dict]:
    if not any(_usable_bytes(w, safety_gb, target_fill) for w in workers):
        return workers
    ranked = sorted(
        workers,
        key=lambda w: (_usable_bytes(w, safety_gb, target_fill) or 0, str(w.get("peer_id") or "")),
        reverse=True,
    )
    if len(ranked) < 2:
        return ranked
    last = ranked[0]
    first = ranked[1]
    return [first, *ranked[2:], last]


def _assign_layers_equal(total_layers: int, workers: list[dict]) -> list[dict]:
    count = max(1, len(workers))
    base = total_layers // count
    extra = total_layers % count
    out: list[dict] = []
    start = 0
    for rank, worker in enumerate(workers):
        n_layers = base + (1 if rank < extra else 0)
        end = start + n_layers - 1
        out.append({"worker": worker, "layer_start": start, "layer_end": end, "layer_bytes": 0})
        start = end + 1
    return out


def _assign_layers_explicit(raw: object, workers: list[dict], total_layers: int, layer_bytes: list[int]) -> list[dict]:
    items = raw.get("assignments") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        raise SystemExit("[ERR] --assignments-json doit contenir une liste non vide")
    workers_by_peer = {str(w.get("peer_id") or ""): w for w in workers}
    out: list[dict] = []
    covered: list[tuple[int, int]] = []
    for rank, item in enumerate(items):
        if not isinstance(item, dict):
            raise SystemExit(f"[ERR] assignment #{rank} invalide")
        peer_id = str(item.get("peer_id") or item.get("peerId") or item.get("target_peer_id") or "").strip()
        if not peer_id:
            raise SystemExit(f"[ERR] assignment #{rank} sans peer_id")
        start = _to_int(item.get("layer_start") if item.get("layer_start") is not None else item.get("layerStart"), -1)
        end = _to_int(item.get("layer_end") if item.get("layer_end") is not None else item.get("layerEnd"), -1)
        if start < 0 or end < start or end >= total_layers:
            raise SystemExit(f"[ERR] assignment #{rank} layers invalides: {start}-{end} / total={total_layers}")
        base_worker = dict(workers_by_peer.get(peer_id) or {})
        base_worker.update({
            "peer_id": peer_id,
            "gpu_name": item.get("gpu_name") or item.get("gpuName") or base_worker.get("gpu_name"),
            "gpu_vram_mb": _to_int(item.get("gpu_vram_mb") or item.get("gpuVramMb"), _to_int(base_worker.get("gpu_vram_mb"))) or None,
            "allocated_vram_mb": _to_int(
                item.get("allocated_vram_mb") or item.get("allocatedVramMb"),
                _to_int(base_worker.get("allocated_vram_mb")),
            ) or None,
            "memory_limit_percent": _to_int(
                item.get("memory_limit_percent") or item.get("memoryLimitPercent"),
                _to_int(base_worker.get("memory_limit_percent")),
            ) or None,
            "backend": item.get("backend") or item.get("runtime_backend") or item.get("runtimeBackend") or base_worker.get("backend"),
            "model_format": item.get("model_format") or item.get("format") or base_worker.get("model_format"),
            "local_model_path": item.get("local_model_path") or item.get("localModelPath") or base_worker.get("local_model_path"),
            "source": "explicit",
        })
        layer_total = _sum_layer_bytes(layer_bytes, start, end)
        covered.append((start, end))
        out.append({
            "worker": base_worker,
            "layer_start": start,
            "layer_end": end,
            "layer_bytes": layer_total,
            "usable_bytes": _to_int(base_worker.get("allocated_vram_mb")) * 1024 * 1024,
            "overhead_bytes": 0,
        })
    expected_start = 0
    for start, end in sorted(covered):
        if start != expected_start:
            raise SystemExit(f"[ERR] assignments non contigus: attendu layer {expected_start}, reçu {start}")
        expected_start = end + 1
    if expected_start != total_layers:
        raise SystemExit(f"[ERR] assignments incomplets: couvrent 0-{expected_start - 1}, total={total_layers}")
    return out


def _assign_layers_by_capacity(
    layer_bytes: list[int],
    workers: list[dict],
    first_overhead: int,
    last_overhead: int,
    safety_gb: float,
    target_fill: float,
) -> list[dict]:
    usable = [_usable_bytes(w, safety_gb, target_fill) for w in workers]
    if not any(v for v in usable):
        return _assign_layers_equal(len(layer_bytes), workers)
    if any(v is None or v <= 0 for v in usable):
        missing = [str(workers[i].get("peer_id")) for i, v in enumerate(usable) if v is None or v <= 0]
        raise SystemExit(f"[ERR] VRAM allouée inconnue/insuffisante pour: {', '.join(missing)}")

    total_needed = sum(layer_bytes) + first_overhead + last_overhead
    total_capacity = sum(int(v or 0) for v in usable)
    if total_capacity < total_needed:
        raise SystemExit(
            "[ERR] Capacité workers insuffisante: "
            f"{_gb(total_capacity)} GiB utilisables < {_gb(total_needed)} GiB nécessaires. "
            "Augmente le nombre de workers, la mémoire allouée, ou baisse --safety-gb."
        )

    layer_capacities = [
        int(v or 0) - ((first_overhead if i == 0 else 0) + (last_overhead if i == len(workers) - 1 else 0))
        for i, v in enumerate(usable)
    ]
    if any(v <= 0 for v in layer_capacities):
        missing = [str(workers[i].get("peer_id")) for i, v in enumerate(layer_capacities) if v <= 0]
        raise SystemExit(f"[ERR] VRAM utile insuffisante après réserve commune pour: {', '.join(missing)}")
    total_layer_bytes = sum(layer_bytes)
    total_layer_capacity = sum(layer_capacities)
    targets = [total_layer_bytes * (cap / max(1, total_layer_capacity)) for cap in layer_capacities]

    assignments: list[dict] = []
    layer_idx = 0
    total_layers = len(layer_bytes)
    for rank, worker in enumerate(workers):
        is_first = rank == 0
        is_last = rank == len(workers) - 1
        remaining_workers = len(workers) - rank - 1
        overhead = (first_overhead if is_first else 0) + (last_overhead if is_last else 0)
        capacity = int(usable[rank] or 0)
        layer_budget = capacity - overhead
        if layer_budget < 0:
            raise SystemExit(
                f"[ERR] {worker.get('peer_id')} n'a pas assez de VRAM utile pour ses tenseurs communs "
                f"({_gb(capacity)} GiB utiles, {_gb(overhead)} GiB requis avant les couches)."
            )

        start = layer_idx
        used = 0
        target = targets[rank]
        if is_last:
            while layer_idx < total_layers:
                used += layer_bytes[layer_idx]
                layer_idx += 1
            if used > layer_budget:
                raise SystemExit(
                    f"[ERR] Dernier worker {worker.get('peer_id')} surchargé: "
                    f"{_gb(used + overhead)} GiB > {_gb(capacity)} GiB utiles."
                )
        else:
            max_take_until = total_layers - remaining_workers
            while layer_idx < max_take_until:
                next_bytes = layer_bytes[layer_idx]
                if used == 0 and next_bytes > layer_budget:
                    raise SystemExit(
                        f"[ERR] {worker.get('peer_id')} ne peut même pas charger une couche "
                        f"({_gb(next_bytes + overhead)} GiB > {_gb(capacity)} GiB utiles)."
                    )
                if used > 0:
                    next_used = used + next_bytes
                    if next_used > layer_budget:
                        break
                    if used >= target and abs(target - next_used) > abs(target - used):
                        break
                used += next_bytes
                layer_idx += 1
        end = layer_idx - 1
        assignments.append(
            {
                "worker": worker,
                "layer_start": start,
                "layer_end": end,
                "layer_bytes": used,
                "usable_bytes": capacity,
                "overhead_bytes": overhead,
            }
        )

    if layer_idx != total_layers:
        raise SystemExit(f"[ERR] Placement incomplet: {layer_idx}/{total_layers} couches placées.")
    return assignments


def _worker_speed_score(worker: dict) -> float:
    explicit = float(_to_int(worker.get("perf_score"), 0) or 0)
    if explicit > 0:
        return explicit
    try:
        tps = float(worker.get("tokens_per_sec") or 0)
    except (TypeError, ValueError):
        tps = 0.0
    if tps > 0:
        return tps
    try:
        layer_ms = float(worker.get("layer_ms") or 0)
    except (TypeError, ValueError):
        layer_ms = 0.0
    if layer_ms > 0:
        return 1000.0 / layer_ms
    text = " ".join(str(worker.get(key) or "") for key in ("backend", "gpu_name", "model")).lower()
    if "4070" in text or "cuda" in text or "nvidia" in text:
        return 3.0
    if "m4" in text:
        return 1.5
    if "m1" in text:
        return 0.7
    return 1.0


def _assign_layers_perf_aware(
    layer_bytes: list[int],
    workers: list[dict],
    first_overhead: int,
    last_overhead: int,
    safety_gb: float,
    target_fill: float,
) -> list[dict]:
    usable = [_usable_bytes(w, safety_gb, target_fill) for w in workers]
    if any(v is None or v <= 0 for v in usable):
        return _assign_layers_by_capacity(layer_bytes, workers, first_overhead, last_overhead, safety_gb, target_fill)
    total_layers = len(layer_bytes)
    speeds = [max(0.01, _worker_speed_score(w)) for w in workers]
    speed_total = sum(speeds)
    last_capacity = int(usable[-1] or 0)
    last_layer_budget = last_capacity - last_overhead
    if last_layer_budget <= 0:
        raise SystemExit(
            f"[ERR] Dernier worker {workers[-1].get('peer_id')} n'a pas assez de VRAM utile pour le lm_head "
            f"({_gb(last_capacity)} GiB utiles, {_gb(last_overhead)} GiB requis hors couches)."
        )
    last_reserved_start = total_layers
    last_reserved_used = 0
    while last_reserved_start > 0:
        candidate = layer_bytes[last_reserved_start - 1]
        if last_reserved_used > 0 and last_reserved_used + candidate > last_layer_budget:
            break
        if last_reserved_used == 0 and candidate > last_layer_budget:
            raise SystemExit(
                f"[ERR] Dernier worker {workers[-1].get('peer_id')} ne peut même pas charger une couche finale "
                f"({_gb(candidate + last_overhead)} GiB > {_gb(last_capacity)} GiB utiles)."
            )
        last_reserved_used += candidate
        last_reserved_start -= 1
    assignments: list[dict] = []
    layer_idx = 0
    for rank, worker in enumerate(workers):
        remaining_workers = len(workers) - rank - 1
        overhead = (first_overhead if rank == 0 else 0) + (last_overhead if rank == len(workers) - 1 else 0)
        capacity = int(usable[rank] or 0)
        layer_budget = capacity - overhead
        if layer_budget <= 0:
            raise SystemExit(
                f"[ERR] {worker.get('peer_id')} n'a pas assez de VRAM utile après réserve commune "
                f"({_gb(capacity)} GiB utiles, {_gb(overhead)} GiB requis)."
            )
        start = layer_idx
        used = 0
        if rank == len(workers) - 1:
            while layer_idx < total_layers:
                used += layer_bytes[layer_idx]
                layer_idx += 1
            if used > layer_budget:
                raise SystemExit(
                    f"[ERR] Dernier worker {worker.get('peer_id')} surchargé en mode perf-aware: "
                    f"{_gb(used + overhead)} GiB > {_gb(capacity)} GiB utiles."
                )
        else:
            raw_target = int(round(total_layers * (speeds[rank] / max(0.01, speed_total))))
            target_layers = max(1, raw_target)
            if remaining_workers == 1:
                max_take_until = last_reserved_start
            else:
                max_take_until = min(last_reserved_start - remaining_workers + 1, total_layers - remaining_workers)
            max_take_until = max(layer_idx + 1, max_take_until)
            while layer_idx < max_take_until:
                next_bytes = layer_bytes[layer_idx]
                if remaining_workers != 1 and used > 0 and (layer_idx - start) >= target_layers:
                    break
                if used > 0 and used + next_bytes > layer_budget:
                    break
                if used == 0 and next_bytes > layer_budget:
                    raise SystemExit(
                        f"[ERR] {worker.get('peer_id')} ne peut même pas charger une couche "
                        f"({_gb(next_bytes + overhead)} GiB > {_gb(capacity)} GiB utiles)."
                    )
                used += next_bytes
                layer_idx += 1
        assignments.append({
            "worker": worker,
            "layer_start": start,
            "layer_end": layer_idx - 1,
            "layer_bytes": used,
            "usable_bytes": capacity,
            "overhead_bytes": overhead,
            "perf_score": round(speeds[rank], 4),
            "placement_mode": "perf-aware",
        })
    if layer_idx != total_layers:
        raise SystemExit(f"[ERR] Placement perf-aware incomplet: {layer_idx}/{total_layers} couches placées.")
    return assignments


def _sum_layer_bytes(layer_bytes: list[int], start: int, end: int) -> int:
    if end < start:
        return 0
    return sum(layer_bytes[max(0, start): min(len(layer_bytes), end + 1)])


def _apply_speed_aware_first_shard(
    assignments: list[dict],
    layer_bytes: list[int],
    first_max_layers: int,
) -> tuple[list[dict], dict]:
    meta = {
        "enabled": True,
        "applied": False,
        "reason": "",
        "first_max_layers": int(first_max_layers),
    }
    if len(assignments) < 2:
        meta["reason"] = f"requires_at_least_two_workers:{len(assignments)}"
        return assignments, meta
    total_layers = len(layer_bytes)
    if total_layers < 2:
        meta["reason"] = f"not_enough_layers:{total_layers}"
        return assignments, meta
    max_layers = max(1, min(int(first_max_layers or 2), total_layers - 1))
    first = dict(assignments[0])
    last = dict(assignments[1])
    if int(first.get("layer_start") or 0) != 0:
        meta["reason"] = "first_assignment_does_not_start_at_0"
        return assignments, meta
    current_first_layers = max(0, int(first.get("layer_end") or -1) - int(first.get("layer_start") or 0) + 1)
    if current_first_layers <= max_layers:
        meta["reason"] = "already_within_first_max_layers"
        return assignments, meta
    if len(assignments) > 2:
        out = [dict(item) for item in assignments]
        second = out[1]
        if int(second.get("layer_end") or -1) < max_layers:
            meta["reason"] = "second_assignment_too_small_for_shift"
            return assignments, meta
        first["layer_start"] = 0
        first["layer_end"] = max_layers - 1
        first["layer_bytes"] = _sum_layer_bytes(layer_bytes, int(first["layer_start"]), int(first["layer_end"]))
        second["layer_start"] = max_layers
        second["layer_bytes"] = _sum_layer_bytes(layer_bytes, int(second["layer_start"]), int(second["layer_end"]))
        out[0] = first
        out[1] = second
        meta.update({
            "applied": True,
            "reason": "first_worker_capped_multi_worker",
            "old_first_layers": current_first_layers,
            "new_first_layers": max_layers,
            "first_worker_class": "m1" if _worker_is_m1(first.get("worker") or {}) else "unknown",
        })
        return out, meta
    first["layer_start"] = 0
    first["layer_end"] = max_layers - 1
    first["layer_bytes"] = _sum_layer_bytes(layer_bytes, int(first["layer_start"]), int(first["layer_end"]))
    last["layer_start"] = max_layers
    last["layer_end"] = total_layers - 1
    last["layer_bytes"] = _sum_layer_bytes(layer_bytes, int(last["layer_start"]), int(last["layer_end"]))
    meta.update({
        "applied": True,
        "reason": "first_worker_capped",
        "old_first_layers": current_first_layers,
        "new_first_layers": max_layers,
        "last_layers": max(0, int(last["layer_end"]) - int(last["layer_start"]) + 1),
        "first_worker_class": "m1" if _worker_is_m1(first.get("worker") or {}) else "unknown",
    })
    return [first, last], meta


def _tensor_entry(tensor: object, source_url: str) -> dict:
    name = str(getattr(tensor, "name"))
    shape = [int(x) for x in getattr(tensor, "shape")]
    return {
        "name": name,
        "shape": shape,
        "ggml_type": int(getattr(tensor, "tensor_type")),
        "source_url": source_url,
        "source_offset": int(getattr(tensor, "data_offset")),
        "nbytes": int(getattr(tensor, "n_bytes")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Prépare des manifests range GGUF pour workers VRYX.")
    parser.add_argument("--gguf", required=True, help="Chemin du fichier .gguf source")
    parser.add_argument("--model-id", default="ollama/llama2:70b")
    parser.add_argument("--workers", type=int, default=8, help="Fallback statique si aucun worker JSON/status")
    parser.add_argument("--workers-json", default="", help="JSON ou @fichier contenant une liste de workers/status")
    parser.add_argument("--workers-status-url", default="", help="URL /api/workers/status pour placement live")
    parser.add_argument(
        "--worker-perf-json",
        default="",
        help="JSON ou @fichier [{peer_id,layer_ms|tokens_per_sec|perf_score}] pour auto-placement perf-aware.",
    )
    parser.add_argument(
        "--allocation-mode",
        choices=("capacity", "perf-aware"),
        default=os.environ.get("VRYX_GGUF_ALLOCATION_MODE", "capacity"),
        help="capacity=VRAM only, perf-aware=VRAM + mesures par peer.",
    )
    parser.add_argument(
        "--assignments-json",
        default="",
        help="JSON ou @fichier d'assignments exacts [{peer_id,backend,layer_start,layer_end,local_model_path}]",
    )
    parser.add_argument("--group-id", default="", help="Identifiant logique du manifest multi-backend")
    parser.add_argument("--default-worker-gb", type=float, default=8.0)
    parser.add_argument("--safety-gb", type=float, default=1.0)
    parser.add_argument("--target-fill", type=float, default=0.92)
    parser.add_argument("--preserve-worker-order", action="store_true")
    parser.add_argument("--speed-aware", action="store_true", default=_env_truthy("VRYX_SCHEDULER_SPEED_AWARE"))
    parser.add_argument(
        "--speed-aware-first-max-layers",
        type=int,
        default=_to_int(os.environ.get("VRYX_SCHEDULER_FIRST_MAX_LAYERS") or os.environ.get("VRYX_M1_MAX_LAYERS"), 2),
        help="Quand --speed-aware est actif, limite le premier worker pipeline à N couches.",
    )
    parser.add_argument("--shard-base", default=os.environ.get("VRYX_SHARD_BASE_DIR", "/var/lib/vryx-shards"))
    parser.add_argument("--api-base", default=os.environ.get("VRYX_SHARD_DOWNLOAD_BASE_URL", "https://vryx.eu"))
    parser.add_argument("--source-rel", default="models/ollama/llama2-70b.gguf")
    parser.add_argument("--out-session", default="prepared-llama2-70b-gguf")
    parser.add_argument(
        "--emit-decode-owner",
        action="store_true",
        help="Écrit aussi decode-owner.json: réplique complète pour le dernier peer/final peer.",
    )
    parser.add_argument(
        "--decode-owner-peer-id",
        default="",
        help="Peer cible pour decode-owner.json. Défaut: dernier worker pipeline.",
    )
    args = parser.parse_args()

    source = Path(args.gguf).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"[ERR] GGUF introuvable: {source}")
    shard_base = Path(args.shard_base).expanduser().resolve()
    session_dir = shard_base / args.out_session
    session_dir.mkdir(parents=True, exist_ok=True)

    workers_payload: object | None = None
    if args.workers_json:
        workers_payload = _read_json_arg(args.workers_json)
    elif args.workers_status_url:
        workers_payload = _fetch_json(args.workers_status_url)
    workers = _normalize_workers(workers_payload, args.workers, args.default_worker_gb)
    if args.worker_perf_json:
        workers = _merge_worker_perf(workers, _read_json_arg(args.worker_perf_json))
    if not args.preserve_worker_order:
        workers = _order_workers_for_pipeline(workers, args.safety_gb, args.target_fill)

    source_rel = _safe_rel(args.source_rel)
    _stage_source(source, shard_base, source_rel)
    source_url = f"{args.api_base.rstrip('/')}/api/internal/shard-serve/{quote(source_rel, safe='/')}"

    reader = gguf.GGUFReader(str(source))
    tensors = list(reader.tensors)
    layer_ids = sorted({idx for tensor in tensors if (idx := _layer_index(str(tensor.name))) is not None})
    if not layer_ids:
        raise SystemExit("[ERR] aucun tenseur blk.N.* trouvé dans le GGUF")
    total_layers = max(layer_ids) + 1
    by_layer: dict[int, list[object]] = {idx: [] for idx in range(total_layers)}
    for tensor in tensors:
        idx = _layer_index(str(tensor.name))
        if idx is not None:
            by_layer.setdefault(idx, []).append(tensor)
    layer_bytes = [sum(_tensor_bytes(t) for t in by_layer.get(idx, [])) for idx in range(total_layers)]

    common_first = [t for t in tensors if str(t.name) == "token_embd.weight"]
    common_last = [t for t in tensors if str(t.name) in ("output_norm.weight", "output.weight")]
    first_overhead = sum(_tensor_bytes(t) for t in common_first)
    last_overhead = sum(_tensor_bytes(t) for t in common_last)
    explicit_assignments = _read_json_arg(args.assignments_json) if args.assignments_json else None
    if explicit_assignments is not None:
        assignments = _assign_layers_explicit(explicit_assignments, workers, total_layers, layer_bytes)
    elif args.allocation_mode == "perf-aware":
        assignments = _assign_layers_perf_aware(
            layer_bytes,
            workers,
            first_overhead,
            last_overhead,
            safety_gb=args.safety_gb,
            target_fill=args.target_fill,
        )
    else:
        assignments = _assign_layers_by_capacity(
            layer_bytes,
            workers,
            first_overhead,
            last_overhead,
            safety_gb=args.safety_gb,
            target_fill=args.target_fill,
        )
    speed_aware_meta = {"enabled": bool(args.speed_aware), "applied": False}
    if args.speed_aware and explicit_assignments is None:
        assignments, speed_aware_meta = _apply_speed_aware_first_shard(
            assignments,
            layer_bytes,
            args.speed_aware_first_max_layers,
        )
    elif explicit_assignments is not None:
        speed_aware_meta = {"enabled": bool(args.speed_aware), "applied": False, "reason": "explicit_assignments"}

    summary = {
        "ok": True,
        "format": "gguf-ranges-v1",
        "placement": (
            "perf-aware-contiguous+speed-aware"
            if args.allocation_mode == "perf-aware" and speed_aware_meta.get("applied")
            else ("perf-aware-contiguous" if args.allocation_mode == "perf-aware" else (
                "allocated-vram-greedy+speed-aware" if speed_aware_meta.get("applied") else "allocated-vram-greedy"
            ))
        ),
        "allocation_mode": args.allocation_mode,
        "group_id": args.group_id or args.out_session,
        "explicit_assignments": explicit_assignments is not None,
        "speed_aware": speed_aware_meta,
        "model_id": args.model_id,
        "gguf": str(source),
        "source_url": source_url,
        "workers": len(assignments),
        "total_layers": total_layers,
        "safety_gb": args.safety_gb,
        "target_fill": args.target_fill,
        "model_bytes": source.stat().st_size,
        "manifests": [],
    }

    for rank, item in enumerate(assignments):
        worker = item["worker"]
        start = int(item["layer_start"])
        end = int(item["layer_end"])
        selected = []
        if rank == 0:
            selected.extend(common_first)
        selected.extend(t for idx in range(start, end + 1) for t in by_layer.get(idx, []))
        if rank == len(assignments) - 1:
            selected.extend(common_last)
        entries = [_tensor_entry(t, source_url) for t in selected]
        total_bytes = sum(int(e["nbytes"]) for e in entries)
        usable_bytes = int(item.get("usable_bytes") or 0)
        next_peer_id = ""
        if rank + 1 < len(assignments):
            next_peer_id = str((assignments[rank + 1].get("worker") or {}).get("peer_id") or "")
        backend = str(worker.get("backend") or "mlx").strip().lower() or "mlx"
        manifest = {
            "ok": True,
            "format": "gguf-ranges-v1",
            "group_id": args.group_id or args.out_session,
            "peer_id": worker.get("peer_id"),
            "backend": backend,
            "model_format": "gguf-ranges-v1",
            "local_model_path": worker.get("local_model_path") or "",
            "next_peer_id": next_peer_id,
            "model_id": args.model_id,
            "rank": rank,
            "workers": len(assignments),
            "target_peer_id": worker.get("peer_id"),
            "gpu_name": worker.get("gpu_name"),
            "gpu_vram_mb": worker.get("gpu_vram_mb"),
            "allocated_vram_mb": worker.get("allocated_vram_mb"),
            "memory_limit_percent": worker.get("memory_limit_percent"),
            "layer_start": start,
            "layer_end": end,
            "num_layers": max(0, end - start + 1),
            "has_embedding": rank == 0,
            "has_lm_head": rank == len(assignments) - 1,
            "source_url": source_url,
            "tensor_sources": entries,
            "binary_total_bytes": total_bytes,
            "usable_bytes": usable_bytes or None,
            "planned_fill_percent": round((total_bytes / usable_bytes) * 100, 1) if usable_bytes > 0 else None,
            "speed_aware": speed_aware_meta,
        }
        path = session_dir / f"worker-{rank}.json"
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        summary["manifests"].append(
            {
                "rank": rank,
                "target_peer_id": worker.get("peer_id"),
                "peer_id": worker.get("peer_id"),
                "backend": backend,
                "model_format": "gguf-ranges-v1",
                "local_model_path": worker.get("local_model_path") or "",
                "next_peer_id": next_peer_id,
                "gpu_name": worker.get("gpu_name"),
                "allocated_vram_mb": worker.get("allocated_vram_mb"),
                "path": str(path),
                "layer_start": start,
                "layer_end": end,
                "num_layers": max(0, end - start + 1),
                "tensors": len(entries),
                "bytes": total_bytes,
                "gb": _gb(total_bytes),
                "usable_gb": _gb(usable_bytes) if usable_bytes else None,
                "planned_fill_percent": manifest["planned_fill_percent"],
                "download_url": f"{args.api_base.rstrip('/')}/api/internal/shard-serve/{args.out_session}/worker-{rank}.json",
            }
        )

    if args.emit_decode_owner:
        owner_worker = assignments[-1]["worker"] if assignments else workers[-1]
        if args.decode_owner_peer_id:
            owner_worker = next(
                (
                    item["worker"]
                    for item in assignments
                    if str((item.get("worker") or {}).get("peer_id") or "") == args.decode_owner_peer_id
                ),
                {
                    "peer_id": args.decode_owner_peer_id,
                    "gpu_name": None,
                    "gpu_vram_mb": None,
                    "allocated_vram_mb": None,
                    "memory_limit_percent": None,
                    "source": "decode-owner-cli",
                },
            )
        selected_owner = []
        selected_owner.extend(common_first)
        selected_owner.extend(t for idx in range(total_layers) for t in by_layer.get(idx, []))
        selected_owner.extend(common_last)
        owner_entries = [_tensor_entry(t, source_url) for t in selected_owner]
        owner_total_bytes = sum(int(e["nbytes"]) for e in owner_entries)
        owner_manifest = {
            "ok": True,
            "format": "gguf-ranges-v1",
            "group_id": args.group_id or args.out_session,
            "peer_id": owner_worker.get("peer_id"),
            "backend": owner_worker.get("backend") or "mlx",
            "model_format": "gguf-ranges-v1",
            "local_model_path": owner_worker.get("local_model_path") or "",
            "next_peer_id": "",
            "role": "decode_owner",
            "decode_owner": True,
            "model_id": args.model_id,
            "rank": "decode-owner",
            "workers": 1,
            "target_peer_id": owner_worker.get("peer_id"),
            "gpu_name": owner_worker.get("gpu_name"),
            "gpu_vram_mb": owner_worker.get("gpu_vram_mb"),
            "allocated_vram_mb": owner_worker.get("allocated_vram_mb"),
            "memory_limit_percent": owner_worker.get("memory_limit_percent"),
            "layer_start": 0,
            "layer_end": total_layers - 1,
            "num_layers": total_layers,
            "has_embedding": True,
            "has_lm_head": True,
            "source_url": source_url,
            "tensor_sources": owner_entries,
            "binary_total_bytes": owner_total_bytes,
            "decode_owner_strategy": "final_peer_full_replica_local_decode",
            "speed_aware": speed_aware_meta,
        }
        owner_path = session_dir / "decode-owner.json"
        owner_path.write_text(json.dumps(owner_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        summary["decode_owner"] = {
            "enabled": True,
            "target_peer_id": owner_worker.get("peer_id"),
            "path": str(owner_path),
            "layer_start": 0,
            "layer_end": total_layers - 1,
            "num_layers": total_layers,
            "tensors": len(owner_entries),
            "bytes": owner_total_bytes,
            "gb": _gb(owner_total_bytes),
            "download_url": f"{args.api_base.rstrip('/')}/api/internal/shard-serve/{args.out_session}/decode-owner.json",
            "strategy": "final_peer_full_replica_local_decode",
        }

    summary_path = session_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
