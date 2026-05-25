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


def _read_json_arg(value: str) -> object:
    src = value.strip()
    if src.startswith("@"):
        return json.loads(Path(src[1:]).expanduser().read_text(encoding="utf-8"))
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
            "source": "static",
        }
        for rank in range(max(1, fallback_count))
    ]


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
    parser.add_argument("--default-worker-gb", type=float, default=8.0)
    parser.add_argument("--safety-gb", type=float, default=1.0)
    parser.add_argument("--target-fill", type=float, default=0.92)
    parser.add_argument("--preserve-worker-order", action="store_true")
    parser.add_argument("--shard-base", default=os.environ.get("VRYX_SHARD_BASE_DIR", "/var/lib/vryx-shards"))
    parser.add_argument("--api-base", default=os.environ.get("VRYX_SHARD_DOWNLOAD_BASE_URL", "https://vryx.eu"))
    parser.add_argument("--source-rel", default="models/ollama/llama2-70b.gguf")
    parser.add_argument("--out-session", default="prepared-llama2-70b-gguf")
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
    assignments = _assign_layers_by_capacity(
        layer_bytes,
        workers,
        first_overhead,
        last_overhead,
        safety_gb=args.safety_gb,
        target_fill=args.target_fill,
    )

    summary = {
        "ok": True,
        "format": "gguf-ranges-v1",
        "placement": "allocated-vram-greedy",
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
        manifest = {
            "ok": True,
            "format": "gguf-ranges-v1",
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
        }
        path = session_dir / f"worker-{rank}.json"
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        summary["manifests"].append(
            {
                "rank": rank,
                "target_peer_id": worker.get("peer_id"),
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

    summary_path = session_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
