#!/bin/bash

# Measure the speedex example: execution quality natively, gas on a devnode,
# and graph both.
#
# The engine's quality (clearing error, unsettled trades) is a pure function
# of the batch, so `tests/quality.rs` sweeps it natively over thousands of
# synthetic batches. Gas is not: the mock environment does not meter it the
# way a node does, so `tests/testkit_gas.rs` runs the real artifact on a local
# `hog-devnode` and reads the receipts. Both write CSVs into `target/`, and
# `speedex-plot.py` draws them into `target/speedex-bench/`.
#
# Needs the devnode toolchain (`thruput toolchain install`) for the gas half;
# without it, only the quality half and its figure are produced. NO_BUILD skips
# the artifact builds; NO_GAS skips the devnode.

set -euo pipefail
cd "$(dirname "$0")/.."

# The guest memory the benchmark's artifact declares, in bytes (`initial_memory_bytes`), and the
# devnode admits; the protocol's default is 64 KiB.
SPEEDEX_GUEST_MEMORY="${SPEEDEX_GUEST_MEMORY:-262144}"

echo "== execution quality (native) =="
cargo test -p speedex --release --test quality -- --ignored --nocapture

if [ ! -v NO_GAS ]; then
    if [ ! -v NO_BUILD ]; then
        thruput build -p erc20 -- -F metadata
        # The guest memory an artifact declares lives in its manifest and bounds the batches it
        # can clear (`max_clear_cells`); the committed manifest keeps the protocol's 64 KiB, which
        # the mock RV32 tests need, so the benchmark's artifact is built from a copy that
        # declares more. Rebuild without this before using the artifact for anything else.
        manifest=contracts/speedex/Cargo.toml
        cp "$manifest" "$manifest.bench-orig"
        trap 'mv "$manifest.bench-orig" "$manifest"' EXIT
        printf '\n[package.metadata.thruput]\ninitial_memory_bytes = %s\n' \
            "$SPEEDEX_GUEST_MEMORY" >> "$manifest"
        thruput build -p speedex
        mv "$manifest.bench-orig" "$manifest"
        trap - EXIT
    fi
    if devnode="$(thruput toolchain which 2>/dev/null)"; then
        echo "== gas (devnode $devnode) =="
        # The exchange declares more guest memory than the protocol's default, which the chain
        # must admit; the testkit cannot pass genesis overrides, so the devnode goes through a
        # wrapper that adds one.
        wrapper="$(mktemp)"
        printf '#!/bin/sh\nexec "%s" "$@" --network-config max_rv32_memory_bytes=%s\n' \
            "$devnode" "$SPEEDEX_GUEST_MEMORY" > "$wrapper"
        chmod +x "$wrapper"
        SPEEDEX_GUEST_MEMORY="$SPEEDEX_GUEST_MEMORY" \
        THRUPUT_DEVNODE_BINARY="$wrapper" \
        THRUPUT_TESTKIT_ARTIFACT_ROOT="$(realpath target/thruput)" \
            cargo test -p speedex --test testkit_gas -- --ignored --nocapture
        rm -f "$wrapper"
    else
        echo "no devnode installed (thruput toolchain install); skipping the gas measurements"
    fi
fi

if python3 -c "import matplotlib" 2>/dev/null; then
    python3 scripts/speedex-plot.py
else
    echo "matplotlib not installed; the CSVs are in target/ (pip install matplotlib to graph them)"
fi
