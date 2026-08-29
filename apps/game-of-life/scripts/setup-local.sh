#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-groundhog}"
environment_path="$app_dir/.env.local"

: "${GROUNDHOG_RUNTIME_MANIFEST:?Set GROUNDHOG_RUNTIME_MANIFEST to the active runtime manifest}"
: "${GROUNDHOG_CONTRACT_ADDRESS:?Set GROUNDHOG_CONTRACT_ADDRESS to the initialized Life contract}"
: "${GAME_OF_LIFE_INDEXER_URL:?Set GAME_OF_LIFE_INDEXER_URL to the loopback indexer origin}"
export GROUNDHOG_RPC_URL="${GROUNDHOG_RPC_URL:-http://127.0.0.1:9545}"
if [[ "${GAME_OF_LIFE_ENV_LOCK_HELD:-0}" != "1" ]]; then
  exec 9>"$app_dir/.env.local.lock"
  if ! flock -n 9; then
    printf 'Another Game of Life setup or acceptance run owns .env.local.\n' >&2
    exit 1
  fi
fi
if [[ -L "$environment_path" ]]; then
  printf 'Refusing a symlinked .env.local path.\n' >&2
  exit 1
fi
environment_backup="$(mktemp "${TMPDIR:-/tmp}/groundhog-life-env.XXXXXX")"
had_environment=0
setup_complete=0
generated_environment_fingerprint=""
initial_environment_fingerprint=""
if [[ -f "$environment_path" ]]; then
  cp -p "$environment_path" "$environment_backup"
  had_environment=1
  initial_environment_fingerprint="$(sha256sum "$environment_path")"
  initial_environment_fingerprint="${initial_environment_fingerprint%%[[:space:]]*}"
fi
restore_environment() {
  if (( setup_complete == 0 )); then
    current_fingerprint=""
    if [[ -f "$environment_path" && ! -L "$environment_path" ]]; then
      current_fingerprint="$(sha256sum "$environment_path")"
      current_fingerprint="${current_fingerprint%%[[:space:]]*}"
    fi
    expected_fingerprint="$generated_environment_fingerprint"
    if [[ -z "$expected_fingerprint" ]]; then
      expected_fingerprint="$initial_environment_fingerprint"
    fi
    if [[ "$current_fingerprint" == "$expected_fingerprint" ]]; then
      if (( had_environment == 1 )); then
        cp -p "$environment_backup" "$environment_path"
      else
        rm -f "$environment_path"
      fi
    else
      printf 'Preserving .env.local because it changed during setup.\n' >&2
    fi
  fi
  rm -f "$environment_backup"
}
trap restore_environment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$app_dir"

for persona in dev-1 dev-2 dev-3; do
  "$groundhog_cli" airdrop "$persona" --amount 1000 --yes \
    --rpc-url "$GROUNDHOG_RPC_URL" \
    --runtime-manifest "$GROUNDHOG_RUNTIME_MANIFEST" >/dev/null
done

"$app_dir/node_modules/.bin/tsx" "$app_dir/scripts/setup-local.ts"
generated_environment_fingerprint="$(sha256sum "$environment_path")"
generated_environment_fingerprint="${generated_environment_fingerprint%%[[:space:]]*}"
if [[ -n "${GAME_OF_LIFE_ENV_FINGERPRINT_FILE:-}" ]]; then
  printf '%s\n' "$generated_environment_fingerprint" >"$GAME_OF_LIFE_ENV_FINGERPRINT_FILE"
fi
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 \
  "$app_dir/node_modules/.bin/vitest" run --mode local-integration \
  "$app_dir/src/integration/life.local.test.ts"
setup_complete=1
