#!/usr/bin/env bash
# Called by webhook.py and also runnable manually: bash deploy/redeploy.sh
set -euo pipefail

REPO_DIR="${1:-/opt/app}"
cd "$REPO_DIR"

echo "[$(date -u +%FT%TZ)] === Redeploy started ==="

# Discard any accidental local changes (code files only — volumes are safe)
git fetch origin
git reset --hard origin/main 2>/dev/null || git reset --hard origin/master

# Rebuild and restart all containers; named volume (dwb_data) is untouched
docker compose up -d --build --remove-orphans

echo "[$(date -u +%FT%TZ)] === Redeploy complete ==="
