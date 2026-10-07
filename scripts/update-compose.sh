#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

echo "Using: ${compose[*]}"
echo "Pulling latest images..."
"${compose[@]}" pull

echo "Restarting services with updated images..."
"${compose[@]}" up -d --force-recreate

echo "Done."
