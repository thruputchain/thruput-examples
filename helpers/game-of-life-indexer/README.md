# Game of Life Indexer

The indexer downloads a coherent on-chain world snapshot, verifies its population and digest, derives immutable tiles, and serves one configured network and contract on loopback HTTP.

## Run

Set `GROUNDHOG_RPC_URL`, `GROUNDHOG_NETWORK_ID`, and `GROUNDHOG_CONTRACT_ADDRESS`. Optional settings include `GAME_OF_LIFE_ARTIFACT_ROOT`, `GAME_OF_LIFE_INDEXER_DB`, `GAME_OF_LIFE_INDEXER_LISTEN`, `GAME_OF_LIFE_CORS_ORIGINS`, and the positive integer `GAME_OF_LIFE_RETENTION_GRACE_SECONDS`.

```bash
cargo run -p game-of-life-indexer --release
```

## Live Acceptance

Start with an initialized generation-zero contract and a funded test wallet. The script indexes generation zero, runs the existing full-world advance, indexes generation one, and verifies SQLite state, artifacts, HTTP responses, restart recovery, and byte-for-byte publication stability at both generations.

```bash
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545
export GROUNDHOG_NETWORK_ID=<64-lowercase-hex-network-id>
export GROUNDHOG_CONTRACT_ADDRESS=0x<64-lowercase-hex-contract-address>
export GROUNDHOG_RUNTIME_MANIFEST=<runtime-manifest-if-required>
helpers/game-of-life-indexer/scripts/live-acceptance.sh
```

Set `GAME_OF_LIFE_LIVE_WORKDIR` to preserve the SQLite database and artifacts after the script exits. Otherwise, the script uses and removes a temporary directory.
