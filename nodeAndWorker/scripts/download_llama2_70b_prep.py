#!/usr/bin/env python3
"""
Utilitaire de préchargement/validation du modèle Hugging Face.

Objectif:
- Résoudre le token HF (HF_TOKEN > HF_TOKEN_FILE > aucune).
- Préparer le cache HF (HF_HOME / HF_HUB_CACHE).
- Télécharger uniquement les patterns demandés.
- Afficher un inventaire local précis pour valider la préparation des shards.

Usage:
  python3 download_llama2_70b_prep.py --model meta-llama/Llama-2-70b-hf --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Optional


def _resolve_env_paths() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def _read_first_token(value: Optional[str], token_file: str) -> Optional[str]:
    if value:
        token = value.strip()
        if token:
            return token
    token_path = os.path.expanduser(token_file)
    if not token_path or not os.path.isfile(token_path):
        return None
    try:
        with open(token_path, "r", encoding="utf-8") as fp:
            token = fp.readline().strip()
        return token or None
    except Exception:
        return None


def _prepare_cache(hf_home: str, hf_hub_cache: str) -> None:
    if hf_home:
        os.environ["HF_HOME"] = hf_home
        os.makedirs(hf_home, exist_ok=True)
    if hf_hub_cache:
        os.environ["HF_HUB_CACHE"] = hf_hub_cache
        os.makedirs(hf_hub_cache, exist_ok=True)


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _print_inventory(path: str) -> None:
    total_bytes = 0
    files: list[tuple[str, int]] = []
    for root, _dirs, filenames in os.walk(path):
        for fname in filenames:
            full = os.path.join(root, fname)
            try:
                st = os.stat(full)
            except FileNotFoundError:
                continue
            files.append((os.path.relpath(full, path), st.st_size))
            total_bytes += st.st_size
    files.sort(key=lambda item: item[0])
    print(f"[OK] snapshot local : {len(files)} fichiers, {total_bytes / (1024**3):.2f} GiB")
    for relpath, size in files[:400]:
        print(f" - {relpath} ({size / (1024**2):.2f} MiB)")
    if len(files) > 400:
        print(f" - ... et {len(files) - 400} autres")


def _print_hf_error(exc: BaseException, model_id: str) -> None:
    msg = str(exc).lower()
    if "gated repo" in msg or "restricted" in msg or "authorized list" in msg:
        print(f"[ERR] Modèle gated: le token ne donne pas accès à {model_id!r}.")
        return
    try:
        from huggingface_hub import errors as hf_errors
    except Exception:
        hf_errors = None
    if hf_errors is not None:
        if isinstance(exc, getattr(hf_errors, "GatedRepoError", tuple())):
            print(f"[ERR] modèle gated: ton token n'a pas accès à {model_id!r}.")
            return
        if isinstance(exc, getattr(hf_errors, "RepositoryNotFoundError", tuple())):
            print(f"[ERR] repo introuvable: vérifie MODEL_ID={model_id!r}.")
            return
        if isinstance(exc, getattr(hf_errors, "HTTPError", tuple())):
            print(f"[ERR] erreur HTTP HF: {exc}")
            return
        if isinstance(exc, getattr(hf_errors, "EntryNotFoundError", tuple())):
            print("[ERR] patterns trop stricts, aucun poids correspondant.")
            return
    print(f"[ERR] erreur HF: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Précharge un modèle HF avec patterns contrôlés.")
    parser.add_argument("--model", default="meta-llama/Llama-2-70b-hf", help="repo HF")
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN", ""), help="Token HF direct")
    parser.add_argument("--token-file", default=os.environ.get("HF_TOKEN_FILE", "~/.cache/huggingface/token"), help="Fichier token")
    parser.add_argument("--hf-home", default=os.environ.get("HF_HOME", "~/.cache/huggingface"))
    parser.add_argument("--hf-hub-cache", default=os.environ.get("HF_HUB_CACHE", ""), help="Cache HF explicite")
    parser.add_argument("--local-dir", default=os.environ.get("VRYX_MODEL_SNAPSHOT_DIR", ""), help="Dossier snapshot final fixe (sans hash HF)")
    parser.add_argument("--revision", default=os.environ.get("HF_REVISION", ""), help="Revision/tag/sha")
    parser.add_argument("--patterns", default="*.json,*.safetensors,tokenizer*,*.model,*.tiktoken,merges.txt,vocab.*,special_tokens_map.json,generation_config.json")
    parser.add_argument("--max-workers", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true", help="Valide la config et affiche les infos sans téléchargement réel")
    parser.add_argument("--skip-config", action="store_true", help="Ne pas charger AutoConfig (plus rapide)")
    parser.add_argument("--print-model-info", action="store_true", help="Affiche info du modèle via AutoConfig")
    args = parser.parse_args()

    _resolve_env_paths()
    token = _read_first_token(args.token, os.path.expanduser(args.token_file))
    _prepare_cache(os.path.expanduser(args.hf_home), os.path.expanduser(args.hf_hub_cache) if args.hf_hub_cache else "")

    print(f"[INFO] Modèle visé : {args.model}")
    print(f"[INFO] Token source : {'HF_TOKEN' if args.token else ('HF_TOKEN_FILE' if token else 'none')}")
    print(f"[INFO] HF_HOME : {os.environ.get('HF_HOME')}")
    if args.hf_hub_cache:
        print(f"[INFO] HF_HUB_CACHE : {os.environ.get('HF_HUB_CACHE')}")
    if args.local_dir:
        print(f"[INFO] LOCAL_DIR : {os.path.expanduser(args.local_dir)}")

    if args.print_model_info:
        try:
            from transformers import AutoConfig

            cfg = AutoConfig.from_pretrained(args.model, revision=args.revision or None, token=token, trust_remote_code=True)
            print(f"[INFO] model_type={cfg.model_type}")
            print(f"[INFO] vocab_size={getattr(cfg, 'vocab_size', 'n/a')}")
            print(f"[INFO] hidden_size={getattr(cfg, 'hidden_size', getattr(cfg, 'n_embd', 'n/a'))}")
            print(f"[INFO] num_layers={getattr(cfg, 'num_hidden_layers', getattr(cfg, 'n_layer', 'n/a'))}")
        except Exception as exc:
            if "transformers" in str(exc):
                print("[WARN] transformers non installé -> skip de l'inspection config (download HF possible).")
            else:
                _print_hf_error(exc, args.model)
                if args.dry_run:
                    return 1
                print("[ERR] Arrêt (chargement config échoué).")
                return 1

    if args.dry_run:
        print("[OK] dry-run terminé.")
        return 0

    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        print(f"[ERR] huggingface_hub manquant: {exc}")
        return 1

    kwargs: dict[str, Any] = {
        "repo_id": args.model,
        "allow_patterns": _split_csv(args.patterns),
        "max_workers": max(1, min(32, int(args.max_workers))),
        "resume_download": True,
        "local_dir_use_symlinks": False,
        "token": token,
    }
    if args.revision:
        kwargs["revision"] = args.revision.strip()
    if args.hf_hub_cache:
        kwargs["cache_dir"] = os.path.expanduser(args.hf_hub_cache)
    if args.local_dir:
        local_dir = os.path.expanduser(args.local_dir)
        os.makedirs(local_dir, exist_ok=True)
        kwargs["local_dir"] = local_dir

    try:
        snapshot_dir = snapshot_download(**kwargs)
    except Exception as exc:
        _print_hf_error(exc, args.model)
        return 1

    print(f"[OK] snapshot terminé : {snapshot_dir}")
    _print_inventory(snapshot_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
