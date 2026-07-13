#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TARGET_SCRIPT="$SCRIPT_DIR/../dbhub-host-cli.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_exit_code() {
  local expected="$1"
  shift

  set +e
  "$@" >/dev/null 2>&1
  local actual=$?
  set -e

  [ "$actual" -eq "$expected" ] || \
    fail "Expected exit code $expected, got $actual for: $*"
}

[ -x "$TARGET_SCRIPT" ] || fail "Target script is missing or not executable: $TARGET_SCRIPT"

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

deploy_dir="$test_root/deploy"
mock_bin="$test_root/bin"
docker_args_file="$test_root/docker-args"
mkdir -p "$deploy_dir/.dbhub" "$mock_bin"
touch "$deploy_dir/dbhub.toml" "$deploy_dir/.env"

cat >"$mock_bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$DOCKER_ARGS_FILE"
MOCK
chmod 0755 "$mock_bin/docker"

export DBHUB_DEPLOY_DIR="$deploy_dir"
export DBHUB_IMAGE="registry.example.test/dbhub:verified"
export DOCKER_ARGS_FILE="$docker_args_file"
export PATH="$mock_bin:$PATH"

assert_exit_code 2 "$TARGET_SCRIPT"
[ ! -e "$docker_args_file" ] || fail "Docker ran for an empty command"

assert_exit_code 2 "$TARGET_SCRIPT" serve
[ ! -e "$docker_args_file" ] || fail "Docker ran for an unsupported command"

rm "$deploy_dir/.env"
assert_exit_code 1 "$TARGET_SCRIPT" status
[ ! -e "$docker_args_file" ] || fail "Docker ran without the deployment env file"
touch "$deploy_dir/.env"

"$TARGET_SCRIPT" enable awakening --ttl 10m

cat >"$test_root/expected-args" <<EXPECTED
run
--rm
--pull=never
--network=none
--read-only
--env-file
$deploy_dir/.env
--env
DBHUB_STATE_DIR=/app/.dbhub
--mount
type=bind,src=$deploy_dir/dbhub.toml,dst=/app/dbhub.toml,readonly
--mount
type=bind,src=$deploy_dir/.dbhub,dst=/app/.dbhub
registry.example.test/dbhub:verified
--config
/app/dbhub.toml
enable
awakening
--ttl
10m
EXPECTED

diff -u "$test_root/expected-args" "$docker_args_file" || \
  fail "Docker invocation did not match the host-admin contract"

printf 'PASS: dbhub host CLI wrapper\n'
