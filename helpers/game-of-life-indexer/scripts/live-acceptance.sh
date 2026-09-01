#!/usr/bin/env bash
set -euo pipefail

: "${GROUNDHOG_RPC_URL:?set GROUNDHOG_RPC_URL}"
: "${GROUNDHOG_NETWORK_ID:?set GROUNDHOG_NETWORK_ID}"
: "${GROUNDHOG_CONTRACT_ADDRESS:?set GROUNDHOG_CONTRACT_ADDRESS}"

if [[ -z "${GAME_OF_LIFE_LIVE_WORKDIR:-}" ]]; then
  GAME_OF_LIFE_LIVE_WORKDIR="$(mktemp -d)"
  trap 'rm -rf "$GAME_OF_LIFE_LIVE_WORKDIR"' EXIT
fi
export GAME_OF_LIFE_ARTIFACT_ROOT="$GAME_OF_LIFE_LIVE_WORKDIR/artifacts"
export GAME_OF_LIFE_INDEXER_DB="$GAME_OF_LIFE_LIVE_WORKDIR/indexer.sqlite3"

export GAME_OF_LIFE_EXPECT_GENERATION=0
cargo test -p game-of-life-indexer --release --test live_acceptance \
  indexes_live_generation_and_restarts_byte_identically -- --ignored --exact --nocapture

cargo test -p game-of-life-live-test --release --test feasibility \
  advances_complete_world_once -- --ignored --exact --nocapture

export GAME_OF_LIFE_EXPECT_GENERATION=1
cargo test -p game-of-life-indexer --release --test live_acceptance \
  indexes_live_generation_and_restarts_byte_identically -- --ignored --exact --nocapture
