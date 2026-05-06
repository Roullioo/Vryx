#!/usr/bin/env python3
"""
Déploiement réel du site (Vite + API Node) vers le VPS.

Prérequis locaux : Node.js 20+, npm.
Prérequis distants : Node.js, npm, PM2 (npm i -g pm2), répertoire cible accessible en écriture.

Authentification SSH (au moins une option) :
  - Mot de passe : VRYX_VPS_SSH_PASSWORD
  - Clé : VRYX_VPS_SSH_KEY=/chemin/vers/id_ed25519
  - Sinon : agent SSH + clés par défaut (look_for_keys)

Variables utiles :
  VRYX_VPS_HOST          (défaut : 51.222.26.225)
  VRYX_VPS_USER          (défaut : ubuntu)
  VRYX_WEBSITE_REMOTE_DIR chemin absolu sur le VPS (défaut : /home/<user>/vryx-website)
  VRYX_PM2_APP_NAME      (défaut : vryx-api)
  VRYX_SKIP_BUILD        (défaut : vide) si "1", ne rebuild pas (réutilise website/dist)

Sur le VPS, le dossier server/.env doit déjà exister (secrets, BDD) : il n'est pas inclus dans l'archive.

Usage depuis la racine du dépôt :
  pip install paramiko
  python3 website_deploy.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("Installez les dépendances : pip install paramiko", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent
WEBSITE = REPO_ROOT / "website"

HOST = os.environ.get("VRYX_VPS_HOST", "51.222.26.225")
USER = os.environ.get("VRYX_VPS_USER", "ubuntu")
PASS = os.environ.get("VRYX_VPS_SSH_PASSWORD")
KEY_PATH = os.environ.get("VRYX_VPS_SSH_KEY")
REMOTE_DIR = os.environ.get("VRYX_WEBSITE_REMOTE_DIR", "").strip() or f"/home/{USER}/vryx-website"
REMOTE_HOME = os.environ.get("VRYX_VPS_REMOTE_HOME", "").strip() or f"/home/{USER}"
PM2_NAME = os.environ.get("VRYX_PM2_APP_NAME", "vryx-api")
SKIP_BUILD = os.environ.get("VRYX_SKIP_BUILD") == "1"


def run_local(cmd: list[str], cwd: Path) -> None:
    print(f"[local] {' '.join(cmd)} (cwd={cwd})")
    subprocess.run(cmd, cwd=cwd, check=True)


def build_site() -> None:
    if not WEBSITE.is_dir():
        print(f"[!] Dossier website introuvable : {WEBSITE}", file=sys.stderr)
        sys.exit(1)
    run_local(["npm", "ci"], WEBSITE)
    run_local(["npm", "ci", "--prefix", "server"], WEBSITE)
    run_local(["npm", "run", "build"], WEBSITE)


def make_tarball(path: Path) -> None:
    dist = WEBSITE / "dist"
    if not dist.is_dir():
        print(
            f"[!] {dist} manquant. Lancez le build ou retirez VRYX_SKIP_BUILD=1.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[*] Archive : {path}")
    srv = WEBSITE / "server"
    with tarfile.open(path, "w:gz") as tar:
        tar.add(WEBSITE / "dist", arcname="dist")
        for rel in ("package.json", "package-lock.json", "src"):
            p = srv / rel
            if not p.exists():
                print(f"[!] Fichier requis manquant : {p}", file=sys.stderr)
                sys.exit(1)
            tar.add(p, arcname=f"server/{rel}")


def ssh_connect() -> paramiko.SSHClient:
    if not PASS and not KEY_PATH:
        print(
            "[*] Ni VRYX_VPS_SSH_PASSWORD ni VRYX_VPS_SSH_KEY : tentative avec agent SSH / clés par défaut.",
        )

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict = {
        "hostname": HOST,
        "username": USER,
        "timeout": 45,
    }
    if PASS:
        kwargs["password"] = PASS
    if KEY_PATH:
        kwargs["key_filename"] = KEY_PATH
    if not PASS:
        kwargs["look_for_keys"] = True
        kwargs["allow_agent"] = True

    client.connect(**kwargs)
    return client


def run_remote_bash(ssh: paramiko.SSHClient, script: str) -> int:
    """Exécute un script bash sur le serveur (script envoyé sur stdin)."""
    print("[>] bash -se …")
    stdin, stdout, stderr = ssh.exec_command("bash -se")
    stdin.write(script)
    stdin.channel.shutdown_write()

    while not stdout.channel.exit_status_ready():
        if stdout.channel.recv_ready():
            sys.stdout.write(stdout.channel.recv(4096).decode("utf-8", "replace"))
        if stderr.channel.recv_stderr_ready():
            sys.stderr.write(stderr.channel.recv_stderr(4096).decode("utf-8", "replace"))

    sys.stdout.write(stdout.read().decode("utf-8", "replace"))
    sys.stderr.write(stderr.read().decode("utf-8", "replace"))
    return stdout.channel.recv_exit_status()


def deploy() -> None:
    if not SKIP_BUILD:
        build_site()
    else:
        print("[*] Build ignoré (VRYX_SKIP_BUILD=1)")

    tmp = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
    tmp.close()
    tarball = Path(tmp.name)
    try:
        make_tarball(tarball)
        archive_name = f"vryx-website-deploy-{os.getpid()}.tar.gz"

        print(f"[*] Connexion SSH {USER}@{HOST}…")
        ssh = ssh_connect()
        try:
            remote_tar_path = f"{REMOTE_HOME.rstrip('/')}/{archive_name}"
            print(f"[*] Envoi de l’archive → {remote_tar_path} …")
            sftp = ssh.open_sftp()
            try:
                sftp.put(str(tarball), remote_tar_path)
            finally:
                sftp.close()

            # Chemin absolu recommandé pour REMOTE_DIR (éviter ~ non développé).
            remote_script = f"""
set -euo pipefail
mkdir -p "{REMOTE_DIR}"
rm -rf "{REMOTE_DIR}/dist"
ENV_BACKUP="$(mktemp)"
if [[ -f "{REMOTE_DIR}/server/.env" ]]; then
  cp "{REMOTE_DIR}/server/.env" "$ENV_BACKUP"
fi
rm -rf "{REMOTE_DIR}/server"
tar -xzf "{remote_tar_path}" -C "{REMOTE_DIR}"
rm -f "{remote_tar_path}"
if [[ -s "$ENV_BACKUP" ]]; then
  mv "$ENV_BACKUP" "{REMOTE_DIR}/server/.env"
else
  rm -f "$ENV_BACKUP"
fi
cd "{REMOTE_DIR}/server"
npm ci --omit=dev
if pm2 describe "{PM2_NAME}" >/dev/null 2>&1; then
  pm2 restart "{PM2_NAME}"
else
  pm2 start src/index.js --name "{PM2_NAME}" --cwd "{REMOTE_DIR}/server"
fi
pm2 save || true
"""

            status = run_remote_bash(ssh, remote_script)
            if status != 0:
                print(f"[!] Échec distant (code {status})", file=sys.stderr)
                sys.exit(status)

            print("[+] Déploiement terminé.")
            print(f"    Fichiers statiques : {REMOTE_DIR}/dist")
            print(f"    API PM2 : {PM2_NAME}")
            print(
                "    Vérifiez que Nginx (ou équivalent) sert ce dist et proxifie /api vers le port de l’API.",
            )
        finally:
            ssh.close()
    finally:
        tarball.unlink(missing_ok=True)


if __name__ == "__main__":
    deploy()
