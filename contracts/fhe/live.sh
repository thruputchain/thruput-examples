#!/bin/bash

# Run the FHE contract on a local node configured like the hosted network: build the
# artifact, start `thruput node` with 4,096-byte storage values, upload a keyset and evaluate
# gates through `crank` (contracts/fhe/contract/tests/testkit_gate.rs).
#
# Requires `thruput` (the CLI) on PATH and its devnode toolchain (`thruput toolchain install`).
# Takes about two minutes, most of it the keyset upload. Set NO_BUILD=1 to reuse the artifact.

set -euo pipefail
cd "$(dirname "$0")/../.." # the repository root

if [ ! -v NO_BUILD ]; then
    # The evaluation buffers need 28 KiB of heap, so the stack is smaller than the default 30 KiB.
    thruput build -p fhe --stack-size 16K
fi

state="$(mktemp -d)"
port="${FHE_NODE_PORT:-9547}"
# Today's local node stores at most 1,024 bytes per value; the hosted network, 4,096.
thruput node --port "$port" --json --network-config max_bytestring_len=4096 >"$state/node.json" 2>"$state/node.log" &
node=$!
trap 'kill "$node" 2>/dev/null; wait "$node" 2>/dev/null || true; rm -rf "$state"' EXIT

for _ in $(seq 60); do
    manifest="$(jq -r '.data.runtimeManifest.path // empty' "$state/node.json" 2>/dev/null || true)"
    [ -n "$manifest" ] && break
    sleep 1
done
[ -n "$manifest" ] || { cat "$state/node.log"; echo "the node did not start" >&2; exit 1; }

export THRUPUT_RPC_URL="http://127.0.0.1:$port"
export THRUPUT_RUNTIME_MANIFEST="$manifest"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$(realpath target/thruput)"

cargo test -p fhe --locked --test testkit_gate -- --ignored --no-capture
