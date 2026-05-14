#!/usr/bin/env bash
set -euo pipefail

cd /workspaces

git config --global pull.rebase false
git config --global init.defaultBranch main

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is not installed. Rebuild the devcontainer so the github-cli feature is installed."
  exit 1
fi

if [ -n "${GH_TOKEN:-}" ] && ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf '%s\n' "$GH_TOKEN" | gh auth login --hostname github.com --with-token >/dev/null
fi

if gh auth status --hostname github.com >/dev/null 2>&1; then
  gh auth setup-git --hostname github.com
else
  echo "GitHub CLI is not authenticated."
  echo "Add GH_TOKEN as a Codespaces secret with access to mission-testronaut/testronaut-demo."
  exit 1
fi

clone_if_missing() {
  local repo="$1"
  local directory="$2"

  if [ ! -d "$directory/.git" ]; then
    gh repo clone "$repo" "$directory"
  fi
}

clone_if_missing mission-testronaut/testronaut-examples testronaut-examples
clone_if_missing mission-testronaut/testronaut-demo testronaut-demo
