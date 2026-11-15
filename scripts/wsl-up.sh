#!/bin/bash
# Gera os segredos locais na primeira vez e sobe MAGTRON, Evolution e Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "EVOLUTION_API_KEY=$(openssl rand -hex 24)"
    echo "APP_SECRET=$(openssl rand -hex 32)"
  } > .env
fi
docker compose up -d --build
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
