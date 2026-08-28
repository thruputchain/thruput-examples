# Game of Life Contract

This contract stores a bit-packed 10,000 by 10,000 toroidal Conway world. One successful non-empty `process_next_tick` invocation consumes one queued request and atomically writes the complete next generation.

## Local Checks

```bash
cargo test -p game-of-life-core --locked
cargo test -p integration-test --locked
groundhog build -p game-of-life
groundhog build -p life-storage-admission
```

Native mock-executor tests additionally require the Groundhog FFI credentials reported by `groundhog status`. The live tests below do not require those credentials.

## Live Node

Export the runtime manifest written by the running node:

```bash
export GROUNDHOG_RUNTIME_MANIFEST=/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545
```

Create and fund a disposable wallet if needed. Deployment and initialization are intentionally separate local transactions, but the deterministic deployment target must be funded before the signed deployment transaction is submitted.

```bash
groundhog wallet create --key default --name game-of-life-dev \
  --prefund 1000 --yes --runtime-manifest "$GROUNDHOG_RUNTIME_MANIFEST"

deploy_json=$(groundhog deploy -p game-of-life --wallet game-of-life-dev \
  --runtime-manifest "$GROUNDHOG_RUNTIME_MANIFEST" --dry-run --json)
export GROUNDHOG_CONTRACT_ADDRESS=$(jq -r '.data.predictedAddress' <<<"$deploy_json")
signed_deploy=$(jq -r '.data.signedTx' <<<"$deploy_json")

base=$(jq -r '.bootstrap.storageCostModel.baseDataItemCost' "$GROUNDHOG_RUNTIME_MANIFEST")
byte_cost=$(jq -r '.bootstrap.storageCostModel.bytestringCostPerByte' "$GROUNDHOG_RUNTIME_MANIFEST")
deploy_base=$(jq -r '.bootstrap.storageCostModel.baseContractDeploymentCost' "$GROUNDHOG_RUNTIME_MANIFEST")
deploy_byte_cost=$(jq -r '.bootstrap.storageCostModel.contractDeploymentCostPerByte' "$GROUNDHOG_RUNTIME_MANIFEST")
rcq_entry=$(jq -r '.bootstrap.storageCostModel.rcqCostPerEntry' "$GROUNDHOG_RUNTIME_MANIFEST")
artifact_bytes=$(stat -c %s target/groundhog/game_of_life.rv32a)

prefund_hog=$(jq -nr \
  --argjson base "$base" --argjson byte_cost "$byte_cost" \
  --argjson deploy_base "$deploy_base" --argjson deploy_byte_cost "$deploy_byte_cost" \
  --argjson rcq_entry "$rcq_entry" --argjson artifact_bytes "$artifact_bytes" \
  '((40004 * $base) + (25001024 * $byte_cost) + (64 * $rcq_entry) +
    $deploy_base + ($artifact_bytes * $deploy_byte_cost)) / 10000000')

groundhog transfer "$GROUNDHOG_CONTRACT_ADDRESS" "$prefund_hog" \
  --from game-of-life-dev --runtime-manifest "$GROUNDHOG_RUNTIME_MANIFEST"

curl -sS -X POST -H 'content-type: application/json' \
  --data "$(jq -nc --arg tx "$signed_deploy" \
    '{jsonrpc:"2.0",id:1,method:"groundhog_sendRawTransaction",params:[$tx]}')" \
  "$GROUNDHOG_RPC_URL"
```

The generated floor covers 40,000 world chunks, both banks' 25,000,000 bytes, four metadata/queue storage items, a conservative 1,024-byte metadata value, 64 queue entries, and deployment code storage. Use the same `max_queue_len` in the floor and `initialize` test if changing the default 64.

Initialize the complete 100-million-cell world:

```bash
GAME_OF_LIFE_OUTER_GAS=60000000000 \
GAME_OF_LIFE_TARGET_GAS=59000000000 \
GAME_OF_LIFE_TIMEOUT_SECONDS=600 \
cargo test -p game-of-life-live-test --test feasibility \
  initializes_complete_world --locked -- --ignored --nocapture
```

Submit one request, process the complete next generation, verify generation advancement and bounded reads, then verify an empty crank is a no-op:

```bash
GAME_OF_LIFE_OUTER_GAS=10010000000 \
GAME_OF_LIFE_TARGET_GAS=10000000000 \
GAME_OF_LIFE_TIMEOUT_SECONDS=300 \
cargo test -p game-of-life-live-test --test feasibility \
  advances_complete_world_once --locked -- --ignored --nocapture
```

The measured local threshold is between 7.5 and 10 billion target gas. Use 10 billion until transaction-detail RPC exposes consumed gas.

Additional live checks use the same initialized deployment:

```bash
cargo test -p game-of-life-live-test --test feasibility \
  generation_one_matches_reference --locked -- --ignored --nocapture

cargo test -p game-of-life-live-test --test feasibility \
  failed_crank_preserves_request_and_world --locked -- --ignored --nocapture

cargo test -p game-of-life-live-test --test feasibility \
  concurrent_requests_commit_with_distinct_ids --locked -- --ignored --nocapture

cargo test -p game-of-life-live-test --test feasibility \
  rejects_reinitialization_and_out_of_bounds_reads --locked -- --ignored --nocapture
```

Run the full-scale native reference vector separately in release mode:

```bash
cargo test -p game-of-life-core --release \
  full_scale_generation_one_vector -- --ignored
```

## Storage Gate

Deploy and fund `life-storage-admission`, export its address as `GROUNDHOG_CONTRACT_ADDRESS`, then run:

```bash
cargo test -p game-of-life-live-test --test feasibility \
  admits_production_read_write_shape --locked -- --ignored --nocapture
```

This transaction performs the production storage shape: 20,004 fixed-size chunk reads totaling 12,502,500 bytes and 20,000 writes totaling 12,500,000 bytes.

## Recorded Result

On the local `hogp/81e1cb073cfb` devnode used during implementation:

- RV32 artifact: 39,496 bytes
- Full initialization: 2.02 seconds
- Full scalar generation transition: 7.04 seconds
- 10-billion target gas: passed
- 7.5-billion target gas: deterministic fault
- Full 20,000-chunk write fixture: 1.01 seconds

Wall-clock results are machine-specific. Receipt gas consumption, peak guest memory, and transaction-detail storage metrics were unavailable from this node's public RPC.
