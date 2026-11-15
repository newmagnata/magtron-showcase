#!/bin/bash
# Instala o Docker no Ubuntu/WSL usando os pacotes oficiais do Ubuntu.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
fi
systemctl enable --now docker
docker version --format 'docker {{.Server.Version}}'
docker compose version
