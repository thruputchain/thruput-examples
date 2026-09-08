#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${SWAP_APP_ENV:-$app_dir/.env.local}"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"

if [[ ! -f "$env_file" ]]; then
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

driver_address="${1:?Pass the driver address of a user-created pool; setup creates no pools}"
if [[ ! "$driver_address" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  printf 'Expected a 32-byte pool driver address.\n' >&2
  exit 1
fi
rpc_url="$(read_generated_value VITE_GROUNDHOG_RPC_URL)"
cd "$app_dir"
process_requests="$(./node_modules/.bin/tsx -e "import { toHex0x } from '@groundhogchain/client'; import { SwapDriver } from './src/contracts/generated/swap-driver.ts'; console.log(toHex0x(SwapDriver.processRequests.entrypoint));")"

# `process_requests` drains as deep as the calling transaction's gas limit
# allows, so that limit is what picks the batch size.  `groundhog call` has no
# flag for it and declares its own default, which means this fallback does not
# choose one -- fine against a local devnode, where nothing competes for
# throughput, but not the model for a client on a live network.  See
# "Cranking the Queue" in docs/README-swap.md.
# Use the operator's own CLI key/profile, never a setup-generated browser account.
if ! "$groundhog_cli" call --rpc-url "$rpc_url" "$driver_address" "$process_requests" 0x; then
  printf 'Crank failed. Check the generated setup and node connection.\n' >&2
  exit 1
fi
