#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$app_dir/.env.local"
config_file="$app_dir/.groundhog-config/groundhog/config.toml"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"

if [[ ! -f "$env_file" || ! -f "$config_file" ]]; then
  printf 'Local swap setup is missing. Run setup:local against a fresh node first.\n' >&2
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
environment_network="$(read_generated_value VITE_GROUNDHOG_NETWORK_ID)"
config_network=""
default_key=""
while IFS= read -r line; do
  case "$line" in
    "# generated_network_id = "*) config_network="${line#* = }" ;;
    "default_key = "*) default_key="${line#* = }" ;;
  esac
done < "$config_file"

if [[ ! "$driver_address" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  printf 'Generated driver address is invalid. Rerun setup:local.\n' >&2
  exit 1
fi
if [[ ! "$process_requests" =~ ^0x[0-9a-fA-F]{16}$ ]]; then
  printf 'Generated process_requests entrypoint is invalid. Rerun setup:local.\n' >&2
  exit 1
fi
if [[ "${environment_network#0x}" != "${config_network#0x}" ]]; then
  printf 'Generated app and CLI configuration belong to different networks. Rerun setup:local.\n' >&2
  exit 1
fi
if [[ "$default_key" != '"dev-0"' ]]; then
  printf 'Generated CLI configuration does not select dev-0. Rerun setup:local.\n' >&2
  exit 1
fi
if [[ "$("$groundhog_cli" --version)" != "groundhog 0.6.1" ]]; then
  printf 'Groundhog CLI 0.6.1 is required.\n' >&2
  exit 1
fi

if ! XDG_CONFIG_HOME="$app_dir/.groundhog-config" \
  "$groundhog_cli" call "$driver_address" "$process_requests" 0x; then
  printf 'Crank failed. If the local node restarted, rerun setup:local with its current runtime manifest.\n' >&2
  exit 1
fi
