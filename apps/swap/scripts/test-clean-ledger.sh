#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-$(command -v groundhog || true)}"
devnode_binary="${GROUNDHOG_DEVNODE_BINARY:-$(command -v hog-devnode || true)}"
environment_path="$app_dir/.env.local"
cli_config_path="$app_dir/.groundhog-config/groundhog/config.toml"
had_environment=0
had_cli_config=0
node_pid=""

if [[ -z "$groundhog_cli" || ! -x "$groundhog_cli" ]]; then
  printf 'Set GROUNDHOG_CLI to an executable Groundhog CLI.\n' >&2
  exit 1
fi
if [[ -z "$devnode_binary" || ! -x "$devnode_binary" ]]; then
  printf 'Set GROUNDHOG_DEVNODE_BINARY to an executable hog-devnode.\n' >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/groundhog-swap-e2e.XXXXXX")"
node_output="$work_dir/node.json"
node_log="$work_dir/node.log"
environment_backup="$work_dir/env.local"
cli_config_backup="$work_dir/config.toml"

cleanup() {
  local exit_code=$?
  if [[ -n "$node_pid" ]] && kill -0 "$node_pid" 2>/dev/null; then
    kill -TERM "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
  if (( had_environment == 1 )); then
    cp -p "$environment_backup" "$environment_path"
  else
    rm -f "$environment_path"
  fi
  if (( had_cli_config == 1 )); then
    mkdir -p "$(dirname "$cli_config_path")"
    cp -p "$cli_config_backup" "$cli_config_path"
  else
    rm -f "$cli_config_path"
  fi
  if (( exit_code != 0 )) && [[ -s "$node_log" ]]; then
    printf '\nGroundhog node log:\n' >&2
    while IFS= read -r line; do
      printf '  %s\n' "$line" >&2
    done < "$node_log"
  fi
  rm -rf "$work_dir"
  exit "$exit_code"
}
if [[ -f "$environment_path" ]]; then
  cp -p "$environment_path" "$environment_backup"
  had_environment=1
fi
if [[ -f "$cli_config_path" ]]; then
  cp -p "$cli_config_path" "$cli_config_backup"
  had_cli_config=1
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$groundhog_cli" node \
  --json \
  --port 0 \
  --dev-account-count 3 \
  --dev-account-hog "${GROUNDHOG_E2E_ACCOUNT_HOG:-100}" \
  --hog-devnode-binary "$devnode_binary" \
  >"$node_output" 2>"$node_log" &
node_pid=$!

startup=""
for (( attempt = 0; attempt < 480; attempt += 1 )); do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    wait "$node_pid" || true
    printf 'Groundhog node exited before becoming ready.\n' >&2
    exit 1
  fi
  if [[ -s "$node_output" ]]; then
    startup="$(node -e '
      const fs = require("node:fs");
      const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const rpcUrl = envelope?.data?.rpc_url;
      const manifest = envelope?.data?.runtime_manifest?.path;
      if (envelope?.ok !== true || typeof rpcUrl !== "string" || typeof manifest !== "string") {
        process.exit(1);
      }
      process.stdout.write(`${rpcUrl}\n${manifest}`);
    ' "$node_output" 2>/dev/null || true)"
    if [[ -n "$startup" ]]; then
      break
    fi
  fi
  sleep 0.25
done

if [[ -z "$startup" ]]; then
  printf 'Timed out waiting for Groundhog node startup metadata.\n' >&2
  exit 1
fi

mapfile -t startup_fields <<< "$startup"
rpc_url="${startup_fields[0]:-}"
runtime_manifest="${startup_fields[1]:-}"
if [[ -z "$rpc_url" || -z "$runtime_manifest" || ! -f "$runtime_manifest" ]]; then
  printf 'Groundhog node returned incomplete startup metadata.\n' >&2
  exit 1
fi

printf 'Provisioning clean ledger at %s\n' "$rpc_url"
GROUNDHOG_CLI="$groundhog_cli" \
GROUNDHOG_RPC_URL="$rpc_url" \
GROUNDHOG_RUNTIME_MANIFEST="$runtime_manifest" \
  bash "$app_dir/scripts/setup-local.sh"

printf 'Running ordered AMM acceptance journey\n'
"$app_dir/node_modules/.bin/vitest" run \
  --mode local-integration \
  "$app_dir/src/integration/clean-ledger.local.test.ts"
