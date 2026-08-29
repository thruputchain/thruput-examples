#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-$(command -v groundhog || true)}"
devnode_binary="${GROUNDHOG_DEVNODE_BINARY:-$(command -v hog-devnode || true)}"
environment_path="$app_dir/.env.local"
environment_kind="absent"
environment_link=""
node_pid=""

if [[ -z "$groundhog_cli" || ! -x "$groundhog_cli" ]]; then
  printf 'Set GROUNDHOG_CLI to an executable Groundhog CLI.\n' >&2
  exit 1
fi
if [[ -z "$devnode_binary" || ! -x "$devnode_binary" ]]; then
  printf 'Set GROUNDHOG_DEVNODE_BINARY to an executable hog-devnode.\n' >&2
  exit 1
fi
if ! command -v flock >/dev/null || ! command -v setsid >/dev/null; then
  printf 'The clean-ledger harness requires flock and setsid.\n' >&2
  exit 1
fi
exec 9<"$app_dir"
if ! flock -n 9; then
  printf 'Another token launchpad clean-ledger run is active.\n' >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/groundhog-launchpad-e2e.XXXXXX")"
node_output="$work_dir/node.json"
node_log="$work_dir/node.log"
environment_backup="$work_dir/env.local"
export XDG_CONFIG_HOME="$work_dir/xdg-config"
export XDG_CACHE_HOME="$work_dir/xdg-cache"

cleanup() {
  local exit_code=$?
  if [[ -n "$node_pid" ]] && kill -0 -- "-$node_pid" 2>/dev/null; then
    kill -TERM -- "-$node_pid" 2>/dev/null || true
    for (( attempt = 0; attempt < 40; attempt += 1 )); do
      if ! kill -0 -- "-$node_pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 -- "-$node_pid" 2>/dev/null; then
      kill -KILL -- "-$node_pid" 2>/dev/null || true
    fi
    wait "$node_pid" 2>/dev/null || true
  fi
  rm -f "$environment_path"
  case "$environment_kind" in
    file) cp -p "$environment_backup" "$environment_path" ;;
    symlink) ln -s "$environment_link" "$environment_path" ;;
  esac
  if (( exit_code != 0 )) && [[ -s "$node_log" ]]; then
    printf '\nGroundhog node log:\n' >&2
    while IFS= read -r line; do
      printf '  %s\n' "$line" >&2
    done < "$node_log"
  fi
  rm -rf "$work_dir"
  exit "$exit_code"
}
if [[ -L "$environment_path" ]]; then
  environment_kind="symlink"
  environment_link="$(readlink "$environment_path")"
elif [[ -f "$environment_path" ]]; then
  cp -p "$environment_path" "$environment_backup"
  environment_kind="file"
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node_args=(
  --json
  --port 0
  --dev-account-count 3
  --dev-account-hog "${GROUNDHOG_E2E_ACCOUNT_HOG:-100}"
  --hog-devnode-binary "$devnode_binary"
)
if [[ -n "${GROUNDHOG_E2E_HOGD_PROTOCOL:-}" ]]; then
  node_args+=(--hogd-protocol "$GROUNDHOG_E2E_HOGD_PROTOCOL")
fi

setsid "$groundhog_cli" node "${node_args[@]}" >"$node_output" 2>"$node_log" &
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
      if (envelope?.ok !== true || typeof rpcUrl !== "string" || typeof manifest !== "string") process.exit(1);
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

printf 'Provisioning clean launchpad ledger at %s\n' "$rpc_url"
GROUNDHOG_CLI="$groundhog_cli" \
GROUNDHOG_RPC_URL="$rpc_url" \
GROUNDHOG_RUNTIME_MANIFEST="$runtime_manifest" \
  bash "$app_dir/scripts/setup-local.sh"

printf 'Running ordered token launchpad acceptance journey\n'
"$app_dir/node_modules/.bin/vitest" run \
  --mode local-integration \
  "$app_dir/src/integration/clean-ledger.local.test.ts"
