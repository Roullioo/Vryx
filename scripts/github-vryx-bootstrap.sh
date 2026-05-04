#!/usr/bin/env bash
# Crée le dépôt privé GitHub Roullioo/Vryx et pousse la branche courante.
# Prérequis : `gh auth login` et variable BAPTISTE_GH_USER = identifiant GitHub (pas l’e-mail).
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-Roullioo/Vryx}"
DESCRIPTION="${DESCRIPTION:-Vryx — inférence distribuée, workers et panel admin}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Installez GitHub CLI : https://cli.github.com/"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Exécutez d’abord : gh auth login"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Ce dossier n’est pas un dépôt Git. Lancez : git init && git add -A && git commit -m 'Initial commit'"
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "${BRANCH}" ]]; then
  echo "Aucune branche active."
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "Remote origin : $(git remote get-url origin)"
  git push -u origin "${BRANCH}"
else
  gh repo create "${REPO_SLUG}" \
    --private \
    --description "${DESCRIPTION}" \
    --source=. \
    --remote=origin \
    --push
  echo "Dépôt créé et poussé : https://github.com/${REPO_SLUG}"
fi

if [[ -n "${BAPTISTE_GH_USER:-}" ]]; then
  echo "Collaborateur GitHub : ${BAPTISTE_GH_USER} (permission admin)"
  gh api -X PUT "repos/${REPO_SLUG}/collaborators/${BAPTISTE_GH_USER}" -f permission=admin
  echo "Accès mis à jour. Baptiste doit accepter l’invitation si GitHub l’envoie par e-mail."
else
  echo "Pour les droits admin GitHub : exportez BAPTISTE_GH_USER (identifiant GitHub de Baptiste) puis relancez ce script, ou ajoutez-le dans Paramètres du dépôt > Collaborateurs."
fi
