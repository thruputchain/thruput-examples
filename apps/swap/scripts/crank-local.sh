#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$app_dir/.env.local"
config_file="$app_dir/.groundhog-config/groundhog/config.toml"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"

if [[ ! -f "$env_file" || ! -f "$config_file" ]]; then
  printf 'Local swap setup is missing. Run setup:local first.\n' >&2
  exit 1
fi

read_generated_value() {
  local wanted="$1"
  local key value
  while IFS='=' read -r key value; do
    if [[ "$key" == "$wanted" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done < "$env_file"
  printf 'Generated value %s is missing. Rerun setup:local.\n' "$wanted" >&2
  return 1
}

driver_address="$(read_generated_value VITE_SWAP_DRIVER_ADDRESS)"
process_requests="$(read_generated_value SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT)"

if ! XDG_CONFIG_HOME="$app_dir/.groundhog-config" \
  "$groundhog_cli" call "$driver_address" "$process_requests" 0x; then
  printf 'Crank failed. Check the generated setup and node connection.\n' >&2
  exit 1
fi
