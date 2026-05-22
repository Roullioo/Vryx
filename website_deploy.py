#!/usr/bin/env python3
"""
Déploiement réel du site (Vite + API Node) vers le VPS.

Prérequis locaux : Node.js 20+, npm.
Prérequis distants : Node.js, npm, PM2 (npm i -g pm2), répertoire cible accessible en écriture.

Authentification SSH (au moins une option) :
  - Mot de passe : VRYX_VPS_SSH_PASSWORD
  - Clé : VRYX_VPS_SSH_KEY ou VRYX_VPS_KEY=/chemin/vers/id_ed25519
  - Sinon : agent SSH + clés par défaut (look_for_keys)

Variables utiles :
  VRYX_VPS_HOST          (défaut : 51.222.26.225)
  VRYX_VPS_USER          (défaut : ubuntu)
  VRYX_WEBSITE_REMOTE_DIR chemin absolu sur le VPS (défaut : /var/www/vryx, racine web type Nginx)
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
KEY_PATH = os.environ.get("VRYX_VPS_SSH_KEY") or os.environ.get("VRYX_VPS_KEY")
REMOTE_DIR = os.environ.get("VRYX_WEBSITE_REMOTE_DIR", "").strip() or "/var/www/vryx"
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

    def tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        # macOS metadata files must never be deployed as web assets.
        if Path(info.name).name.startswith("._"):
            return None
        return info

    with tarfile.open(path, "w:gz") as tar:
        tar.add(WEBSITE / "dist", arcname="dist", filter=tar_filter)
        for rel in ("package.json", "package-lock.json", "src", "scripts"):
            p = srv / rel
            if not p.exists():
                print(f"[!] Fichier requis manquant : {p}", file=sys.stderr)
                sys.exit(1)
            tar.add(p, arcname=f"server/{rel}", filter=tar_filter)


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

    print(f"[*] Cible distante (fichiers + API) : {REMOTE_DIR}/")

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

            # Déploiement sous /var/www/vryx : toujours sudo + chown (souvent root:www-data sinon tar échoue).
            remote_script = f"""
set -euo pipefail
REMOTE="{REMOTE_DIR}"
sudo mkdir -p "$REMOTE"
sudo chown -R "$(id -un)":"$(id -gn)" "$REMOTE"
SHARD_DIR="${{VRYX_SHARD_BASE_DIR:-/var/lib/vryx-shards}}"
MIN_FREE_MB="${{VRYX_DEPLOY_MIN_FREE_MB:-10240}}"
sudo mkdir -p "$SHARD_DIR"
free_mb="$(df -Pm "$SHARD_DIR" | awk 'NR==2 {{print $4}}')"
if [[ ! "$free_mb" =~ ^[0-9]+$ ]] || (( free_mb < MIN_FREE_MB )); then
  echo "[remote] ERREUR: espace disque insuffisant pour shards (${{free_mb:-0}} Mo libres, minimum $MIN_FREE_MB Mo) sur $SHARD_DIR" >&2
  exit 1
fi
OLD_ASSETS="$(mktemp -d)"
if [[ -d "$REMOTE/dist/assets" ]]; then
  cp -a "$REMOTE/dist/assets/." "$OLD_ASSETS/" || true
fi
rm -rf "$REMOTE/dist"
ENV_BACKUP="$(mktemp)"
if [[ -f "$REMOTE/server/.env" ]]; then
  cp "$REMOTE/server/.env" "$ENV_BACKUP"
fi
rm -rf "$REMOTE/server"
tar -xzf "{remote_tar_path}" -C "$REMOTE"
rm -f "{remote_tar_path}"
if [[ -d "$REMOTE/dist/assets" && -d "$OLD_ASSETS" ]]; then
  # Keep only non-bundled static assets. Old hashed JS/CSS chunks must not survive,
  # otherwise browsers can keep executing stale admin code after a deploy.
  find "$OLD_ASSETS" -maxdepth 1 -type f ! -name '._*' ! -name '*.js' ! -name '*.css' ! -name '*.map' -exec cp --update=none {{}} "$REMOTE/dist/assets/" \\; || true
fi
rm -rf "$OLD_ASSETS"
find "$REMOTE/dist" -name '._*' -delete 2>/dev/null || true
if [[ -s "$ENV_BACKUP" ]]; then
  mv "$ENV_BACKUP" "$REMOTE/server/.env"
else
  rm -f "$ENV_BACKUP"
fi
if [[ ! -f "$REMOTE/server/.env" && -f "/home/$(id -un)/vryx-website/server/.env" ]]; then
  cp "/home/$(id -un)/vryx-website/server/.env" "$REMOTE/server/.env"
fi
if [[ ! -f "$REMOTE/server/.env" && -f "/home/$(id -un)/apps/vryx/server/.env" ]]; then
  cp "/home/$(id -un)/apps/vryx/server/.env" "$REMOTE/server/.env"
fi
if [[ -f "$REMOTE/server/.env" ]] && grep -q '^PORT=' "$REMOTE/server/.env"; then
  sed -i 's/^PORT=.*/PORT=4000/' "$REMOTE/server/.env"
fi
cd "$REMOTE/server"
npm ci --omit=dev
if pm2 describe "{PM2_NAME}" >/dev/null 2>&1; then
  pm2 delete "{PM2_NAME}"
fi
pm2 start src/index.js --name "{PM2_NAME}" --cwd "$REMOTE/server"
pm2 save || true
ok=0
for _ in 1 2 3 4 5 6; do
  if curl -sfS "http://127.0.0.1:4000/api/health" -o /dev/null; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" -eq 1 ]]; then
  echo "[remote] API : http://127.0.0.1:4000/api/health OK"
else
  echo "[remote] ERREUR: l'API ne répond pas sur le port 4000. Voir: pm2 logs {PM2_NAME} --lines 80" >&2
  echo "[remote] Vérifier: $REMOTE/server/.env (JWT_SECRET, DB_*) et que MariaDB est accessible." >&2
  exit 1
fi
"""

            status = run_remote_bash(ssh, remote_script)
            if status != 0:
                print(f"[!] Échec distant (code {status})", file=sys.stderr)
                sys.exit(status)

            print("[+] Déploiement terminé.")
            print(f"    Fichiers statiques : {REMOTE_DIR}/dist")
            print(f"    API PM2 : {PM2_NAME}")
            print(
                "    Nginx doit avoir : root …/dist avec le même préfixe que la cible ci-dessus (ex. /var/www/vryx/dist).",
            )
            print("    Si la page ne bouge pas : rechargement forcé (Ctrl+Shift+R) ou cache CDN.")
        finally:
            ssh.close()
    finally:
        tarball.unlink(missing_ok=True)


if __name__ == "__main__":
    deploy()
