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
# Needs the devnode toolchain (`groundhog toolchain install`) for the gas half;
# without it, only the quality half and its figure are produced. NO_BUILD skips
# the artifact builds; NO_GAS skips the devnode.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "== execution quality (native) =="
cargo test -p speedex --release --test quality -- --ignored --nocapture

if [ ! -v NO_GAS ]; then
    if [ ! -v NO_BUILD ]; then
        groundhog build -p erc20 -- -F metadata
        groundhog build -p speedex
    fi
    if devnode="$(groundhog toolchain which 2>/dev/null)"; then
        echo "== gas (devnode $devnode) =="
        GROUNDHOG_DEVNODE_BINARY="$devnode" \
        GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)" \
            cargo test -p speedex --test testkit_gas -- --ignored --nocapture
    else
        echo "no devnode installed (groundhog toolchain install); skipping the gas measurements"
    fi
fi

if python3 -c "import matplotlib" 2>/dev/null; then
    python3 scripts/speedex-plot.py
else
    echo "matplotlib not installed; the CSVs are in target/ (pip install matplotlib to graph them)"
fi
