# Game of Life Contract

This contract stores a bit-packed 10,000 by 10,000 toroidal Conway world. One successful non-empty `process_next_tick` invocation consumes one queued request and atomically writes the complete next generation.

## Canonical World and Storage Layout

The world contains `100,000,000` cells. Cells are stored row-major with one LSB-first bit per cell, so each 10,000-cell row occupies exactly `1,250` bytes with no padding. The contract bytestring limit splits every row into a `1,000`-byte head and `250`-byte tail.

One complete generation therefore contains:

| Value | Amount |
| --- | ---: |
| Rows | `10,000` |
| Bytes per row | `1,250` |
| Chunks per row | `2` |
| Chunks per bank | `20,000` |
| Bytes per bank | `12,500,000` |
| Persistent banks at steady state | `2` |
| Raw bytes across both banks | `25,000,000` |

The two persistent banks are named A and B. One bank is immutable input for the current generation while the other receives the next generation. Even generations read A and write B; odd generations read B and write A. Initialization materializes Bank A, and the first non-empty tick materializes Bank B.

### Cell-to-Storage Addressing

For a coordinate `(x, y)`, where both values are in `0..=9,999`, the canonical storage address is:

```text
byte_in_row  = floor(x / 8)
bit          = x % 8
part         = byte_in_row < 1000 ? 0 : 1
byte_in_part = part == 0 ? byte_in_row : byte_in_row - 1000
chunk_key    = y * 2 + part
```

Each byte holds eight adjacent horizontal cells. Bit zero stores the leftmost cell in that byte. The same `chunk_key` exists in both banks; generation parity determines which bank is source and which is destination.

## Tick Request and Processing Semantics

Request admission and generation processing are separate transactions:

1. `request_tick()` inserts attributed intent into the bounded queue.
2. A later permissionless `process_next_tick()` consumes one queued request and advances one generation.
3. The crank submitter does not need to be the original requester. `request_id` and `requester` in `GenerationAdvanced` preserve attribution.
4. An empty crank returns without advancing the generation.

A non-empty `process_next_tick()` performs this ordered work:

1. Read and validate `WorldState`.
2. Consume one queued request in transactional working state.
3. Validate generation and active-bank invariants.
4. Seed a toroidal three-row window from the active bank.
5. Evaluate each destination row, write its two chunks to the inactive bank, and stream population and digest updates.
6. Exclusively switch generation, active bank, population, and digest metadata.
7. Release the queue slot and emit `GenerationAdvanced`.
8. Include the complete result in a block.

The row loop interleaves reads, evaluation, and writes. The active bank remains immutable input throughout the invocation; only the inactive bank receives writes.

### Atomic Commit and Revert Semantics

The inactive bank, metadata handoff, queue slot release, and event commit together. External observers see either the complete state before the tick or the complete state after it. They never see a partially written generation as canonical.

If any step fails, all invocation effects revert: the consumed request returns, bank writes disappear, metadata remains unchanged, queue capacity is not released, and no event survives.

## Fixed Workload

One non-empty tick has this contract-derived workload:

| Work | Amount |
| --- | ---: |
| Logical Conway outcomes | `100,000,000` |
| Canonical bank-chunk reads | `20,004` |
| Canonical bank bytes read | `12,502,500` |
| Canonical bank-chunk writes | `20,000` |
| Canonical bank bytes written | `12,500,000` |
| Visible core row working set | `5,000` bytes |
| Resulting population counts | `1` |
| Streaming state digests | `1` |

These chunk totals exclude metadata, queue, map-key, event, serialization, and runtime operations. The 5,000-byte visible working set consists of three 1,250-byte source rows and one 1,250-byte destination row; SDK and compiler temporaries may raise actual peak guest memory.

### Why One Tick Reads 20,004 Chunks

The toroidal algorithm first loads three rows, or six chunks. It then streams the remaining 9,999 row loads, or 19,998 chunks:

```text
initial window = 3 rows * 2 chunks = 6 reads
stream         = 9,999 rows * 2 chunks = 19,998 reads
total          = 6 + 19,998 = 20,004 reads
```

The two additional row loads preserve wraparound at the top and bottom boundary. They add `2,500` bytes beyond reading one complete bank.

## Local Checks

```bash
cargo test -p game-of-life-core --locked
cargo test -p integration-test --locked
groundhog build -p game-of-life
groundhog build -p life-storage-admission
```

The shared core tests run without a node. Contract storage and lifecycle behavior is covered by the live tests below; native mock-executor coverage still requires Groundhog FFI credentials.

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

## Measured Local Results

On the local `hogp/81e1cb073cfb` devnode used during implementation:

- RV32 artifact: 39,496 bytes
- Full initialization: 2.02 seconds
- Full scalar generation transition: 7.04 seconds
- 10-billion target gas: passed
- 7.5-billion target gas: deterministic fault
- Full 20,000-chunk write fixture: 1.01 seconds

Wall-clock results are machine-specific. Receipt gas consumption, peak guest memory, and transaction-detail storage metrics were unavailable from this node's public RPC.
