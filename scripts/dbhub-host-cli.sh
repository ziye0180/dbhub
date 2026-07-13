#!/usr/bin/env bash

# Author: ziye

set -euo pipefail

readonly DEPLOY_DIR="${DBHUB_DEPLOY_DIR:-/www/dbhub}"
readonly IMAGE="${DBHUB_IMAGE:-registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub:latest}"
readonly CONFIG_PATH="$DEPLOY_DIR/dbhub.toml"
readonly ENV_PATH="$DEPLOY_DIR/.env"
readonly STATE_DIR="$DEPLOY_DIR/.dbhub"

usage() {
  cat <<'USAGE'
Usage:
  dbhub enable <source> [--ttl <duration>]
  dbhub disable <source>
  dbhub status
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

case "${1:-}" in
  enable|disable|status)
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

command -v docker >/dev/null 2>&1 || fail "docker is required"
[ -f "$CONFIG_PATH" ] || fail "DBHub config is missing: $CONFIG_PATH"
[ -f "$ENV_PATH" ] || fail "DBHub environment file is missing: $ENV_PATH"
[ -d "$STATE_DIR" ] || fail "DBHub state directory is missing: $STATE_DIR"

exec docker run \
  --rm \
  --pull=never \
  --network=none \
  --read-only \
  --env-file "$ENV_PATH" \
  --env DBHUB_STATE_DIR=/app/.dbhub \
  --mount "type=bind,src=$CONFIG_PATH,dst=/app/dbhub.toml,readonly" \
  --mount "type=bind,src=$STATE_DIR,dst=/app/.dbhub" \
  "$IMAGE" \
  --config /app/dbhub.toml \
  "$@"
