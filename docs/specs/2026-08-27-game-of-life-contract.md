# Groundhog 100 Million Cell Game of Life Contract
Status: Draft

Date: 2026-08-27
## Summary
Build a Groundhog smart contract that stores a canonical 10,000 by 10,000 Conway's Game of Life world and advances all 100,000,000 cells in one atomic `process_next_tick()` invocation. Users submit commuting tick requests to a retrocausal queue (RCQ); a permissionless crank consumes one request and advances one generation.

The contract must materialize the complete world on-chain. It must not submit a precomputed state root, defer cells, update only requested regions, or divide one generation across externally coordinated transactions.

The first version covers the contract, deterministic initialization, state retrieval, correctness tests, and execution benchmarks. Browser visualization is outside this specification.
## Demonstration Claim
The implementation must support this precise claim:

> One Groundhog contract invocation reads, computes, and commits the exact next state of a persistent 100-million-cell Conway world atomically.

The implementation must not claim that it performs eight independent operations per cell if a later optimization uses bit-parallel processing. The result and atomic state transition matter, not a particular instruction count.
## Goals
- Store exactly 100,000,000 canonical live/dead cells.

- Advance every cell according to Conway's rules in one `process_next_tick()` invocation.

- Commit either the complete next generation or no part of it.

- Initialize the world reproducibly from a seed.

- Expose enough metadata and world data for clients to reconstruct and verify a generation.

- Run within the Groundhog RV32 guest's memory limits by streaming state.

- Record population and a deterministic digest for each committed generation.

- Accept concurrent user demand through commuting queue inserts without concurrent world rewrites.

- Correlate every processed tick request with the generation it produces.

- Measure actual compute, storage, memory, and transaction behavior on a Groundhog devnode.

## Non-Goals
- Browser rendering or a tile server.

- Arbitrary user-uploaded patterns in the first version.

- Multiple Conway rulesets or configurable world dimensions.

- Sparse, procedural, lazy, or off-chain canonical state.

- Historical generations stored indefinitely by the contract.

- Advancing one generation through multiple transactions.

- Processing more than one queued tick in a single crank in the first version.

- Guaranteed request latency, queue fairness, or keeper availability.

- Cancellation of an accepted tick request.

- An administrator who can reset or alter an initialized world.

- Merkle proofs for individual chunks in the first version.

## Groundhog Constraints
The design follows the current examples and the SDK used by this repository:

- Contracts are Rust `no_std` programs built for RV32.

- Contract state uses SDK storage types such as `Value`, `Map`, and `Bytestring`.

- A storage bytestring is limited to 1,024 bytes.

- A contract return value is limited to 1,024 bytes.

- The RV32 guest has 64 KiB of total memory.

- The RV32 allocator is a non-freeing bump allocator, so repeated heap allocation during a generation transition is unsafe even when each allocation is small.

- A failed invocation reverts its storage writes and events.

- `Value::set_exclusive` supplies the commit conflict needed to serialize generation changes.


The repository currently depends on `sdk = 0.19.3`. The nearby SDK checkout is `0.23.1`; the relevant bytestring and RV32 memory behavior is present in both versions. Implementation must compile and test against the repository's pinned dependency unless the repository is upgraded separately.
## Feasibility Gate
The gate has two stages. First, extend one reusable transaction harness to configure outer transaction gas, target-call gas, block expiry, receipt timeout, and status inspection independently. The harness must preserve those settings through the development-wallet wrapper and expose pending, expired or invalid, committed, and failed outcomes. A conflict or exclusion diagnostic remains evidence attached to a pending transaction unless a devnode API proves it terminal; it is not a separate authoritative outcome.

Before implementing the full kernel, use that harness with a storage-shaped RV32 fixture. It must establish that a devnode can admit the expected read count, write count, and transaction delta without yet claiming that production compute or memory is feasible.

After the pure PRNG, digest, and scalar kernel exist, replace the representative computation with the exact production-shaped tick path. The final gate must verify that one successful transaction performs all of the following:

- 20,004 bytestring reads totaling 12,502,500 bytes with the specified three-row toroidal stream.

- 20,000 bytestring writes totaling 12,500,000 bytes.

- The exact scalar neighbor kernel over 100 million cells, population counting, streaming digest chain, production map-key access, metadata update, and event encoding.

- A transaction storage delta containing those writes.

- An explicitly configured transaction and target gas budget above the current 10,000,000 defaults.

- The invocation duration required by block production and transaction timeouts.


The final production-shaped stage, not the preliminary storage fixture, is the principal pass/fail gate. Groundhog's compute capacity does not by itself prove that its admission rules, transaction delta, storage layer, RPC, or block builder accepts the required compute and a 12.5 MB atomic write set. The fixture must record the gas required and confirm every node, block, transaction, target-call, and client limit that must be raised from its default.

The gate must also measure and provision the HOG storage deposit for generation zero, the second 12.5 MB bank created by the first processed tick, metadata, and `max_queue_len` encoded requests. `Slots` bounds queue storage exposure but does not fund it.

Failure of this gate must not be worked around by splitting `process_next_tick()` into multiple transactions. It means the intended demonstration requires a Groundhog protocol or node configuration change, or a documented reduction in world size.
## World Semantics
The world has fixed constants:

```rust
const WORLD_WIDTH: u32 = 10_000;
const WORLD_HEIGHT: u32 = 10_000;
const CELL_COUNT: u64 = 100_000_000;
const ROW_BYTES: usize = 1_250;
```

Each cell follows Conway's standard rule:

- A live cell survives with two or three live neighbors.

- A dead cell becomes live with exactly three live neighbors.

- Every other cell is dead in the next generation.


The world is toroidal. The left and right edges are adjacent, and the top and bottom edges are adjacent. This avoids a special dead border and gives every cell exactly eight neighbors.

Generation zero is the state produced by `initialize`. Each successful, non-empty `process_next_tick()` increments the generation by exactly one and consumes exactly one accepted request.
## Cell Encoding
Cells use a canonical row-major, one-bit representation:

```text
row_offset  = y * 1,250
byte_offset = x / 8
bit_offset  = x % 8
alive       = (byte >> bit_offset) & 1
```

Bits are numbered least-significant bit first within each byte. Rows contain no padding because 10,000 is divisible by eight.

One generation therefore occupies exactly:

```text
100,000,000 bits = 12,500,000 bytes
```
## Storage Layout
Use two persistent banks so the contract can read the complete current generation while writing the next generation:

```rust
#[sdk::storage]
pub struct GameOfLife {
    state: Value<WorldState>,
    bank_a: Map<u32, Bytestring>,
    bank_b: Map<u32, Bytestring>,
    requests: RCQ<TickRequest>,
    request_sequence: NNInt,
    queue_slots: Node<batch_driver::Slots>,
}
```

`WorldState` is a serialized contract type:

```rust
#[contract_type]
pub struct WorldState {
    pub generation: u64,
    pub active_bank: u32,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
    pub max_queue_len: u32,
}
```

`active_bank` must be zero for `bank_a` or one for `bank_b`. No other value is valid.

The absence of `state` means the contract is uninitialized. Do not store a separate initialized flag.

Queued requests and processing results use explicit contract types:

```rust
pub type RequestId = SHA256Hash;

#[contract_type]
pub struct TickRequest {
    pub request_id: RequestId,
    pub requested_by: ContractAddress,
}

#[contract_type]
pub struct TickResult {
    pub request_id: RequestId,
    pub requested_by: ContractAddress,
    pub metadata: WorldMetadata,
}
```

The queue stores only intent and attribution. It never stores world data or a precomputed generation.

Reuse `batch_driver::Slots` from `helpers/batch-driver` for bounded queue admission. Do not use `batch_driver::process` in version one: a Life crank deliberately consumes one request, while that helper is designed to drain as many requests as its gas budget permits.
### Row Chunks
The bytestring limit requires each 1,250-byte row to use two chunks:

```rust
const CHUNK_BYTES: usize = 1_000;
const TAIL_BYTES: usize = 250;
const CHUNKS_PER_ROW: u32 = 2;
const CHUNKS_PER_BANK: u32 = 20_000;
```

Chunk keys are linear and deterministic:

```text
chunk_key = row * 2 + part
```

Part zero stores row bytes `0..1000`. Part one stores row bytes `1000..1250`. The tail is stored at its actual 250-byte length rather than padded.

The first successful `process_next_tick()` creates the second bank. Steady-state world storage is therefore approximately 25 MB across 40,000 bytestring values, excluding keys, queued requests, and metadata.

Do not use `Vector<Bytestring>`. Its length slot adds unnecessary reads and exclusive structural mutations. A `Map<u32, Bytestring>` gives direct deterministic addressing without separately persisted bounds.
## Memory Model
The internal generation transition must not load a complete bank into guest memory and must not allocate once per chunk.

The production kernel uses fixed-size stack buffers for four rows:

- Previous source row: 1,250 bytes.

- Current source row: 1,250 bytes.

- Next source row: 1,250 bytes.

- Destination row: 1,250 bytes.


The core world working set is therefore 5,000 bytes. On SDK 0.19.3, fixed-size reads use `Bytestring::get_sized::<1000>()` and `Bytestring::get_sized::<250>()`. These APIs construct and return fixed arrays by value, so compiler-generated temporaries and copies can make the actual stack peak materially larger than the visible row and chunk buffers. SDK calldata and serialization scratch buffers also consume memory. Inspect the optimized RV32 output or measure peak memory; do not infer the peak from source-level arrays alone.

The production generation-transition path must keep the SDK's `alloc` feature disabled unless profiling proves allocation is necessary and bounded. In particular, it must not call the allocating `Bytestring::get()` in the row loop. Use fixed-size reads and copy them into reusable row buffers.
## Contract Interface
The public API should remain small:

```rust
#[contract(
    throws = GameOfLifeError,
    emits(WorldInitialized, TickRequested, GenerationAdvanced)
)]
impl GameOfLife {
    pub fn initialize(&mut self, seed: u64, max_queue_len: u32) -> WorldMetadata;
    pub fn request_tick(&mut self) -> RequestId;
    pub fn process_next_tick(&mut self) -> Option<TickResult>;
    pub fn get_metadata(&self) -> WorldMetadata;
    pub fn get_chunk(&self, row: u32, part: u32) -> [u8; 1000];
    pub fn get_cell(&self, x: u32, y: u32) -> bool;
}
```

The exact generated client names should follow the patterns used by the existing examples.
### `initialize`
`initialize(seed, max_queue_len)` must:

- Throw `AlreadyInitialized` if `state` exists.

- Generate every cell on-chain from the supplied seed.

- Write generation zero into `bank_a`.

- Set `bank_a` as active.

- Calculate the exact live-cell population.

- Calculate the generation-zero state digest.

- Require `max_queue_len` to be greater than zero and initialize the queue's remaining capacity.

- Persist `WorldState` with an exclusive write.

- Emit one `WorldInitialized` event.

- Return the resulting metadata.


Version one accepts a known local-development limitation: deployment and initialization are two transactions because the current development wallet cannot compose a call to the newly deployed target.

Local setup must:

1. Derive the deterministic target and prefund it.

2. Submit deployment and wait for its committed receipt.

3. Verify the expected Life code exists at the target.

4. Immediately submit `initialize(seed, max_queue_len)` and wait for commitment.

5. Require the expected `WorldInitialized` event and matching metadata before publishing configuration or starting the frontend and indexer.


Another caller can initialize the contract between steps two and four. This race is accepted only on the disposable loopback ledger. If initialization returns `AlreadyInitialized`, setup must compare metadata and fail rather than treating another caller's values as success. The initialized contract has no reset operation. A future devnet deployment must make deployment and initialization atomic or bind the target address to committed initialization parameters before exposing or prefunding it.

Deployment must prefund the deterministic target address for both complete world banks and the maximum configured queue occupancy. Local setup derives the required floor from the pinned runtime manifest's cost model and feasibility measurements, records the cost-model identity with generated configuration, and checks the target balance before deployment. Include an initialization test funded one unit below the generated floor.
### `request_tick`
`request_tick()` is the only public way to request a future generation. It must:

- Throw `NotInitialized` if `state` is absent.

- Reserve one bounded queue slot with a blind, commutative `NNInt` decrement.

- Increment `request_sequence` with a blind, commutative `NNInt` delta.

- Derive a `RequestId` from the source transaction hash and sequence value, following the existing swap-driver pattern.

- Capture `get_caller()` as the requester.

- Insert `TickRequest { request_id, requested_by }` into the RCQ.

- Emit one `TickRequested` event.

- Return the request ID.


RCQ inserts, sequence increments, and slot reservations must commute across concurrent request transactions. If the queue is full, its capacity floor causes the request transaction to be excluded and returned to the mempool rather than committing an unbounded queue entry.

Request transactions must use a bounded expiry. A transaction excluded because the queue is full may otherwise execute much later when processing frees capacity. An expired or authoritatively failed submission has no accepted request; only a committed `TickRequested` event establishes acceptance.
### `process_next_tick`
`process_next_tick()` is a permissionless crank. It must:

- Throw `NotInitialized` if `state` is absent.

- Return `None` without writing state or emitting an event when the queue is empty at the transaction's snapshot.

- Consume exactly one `TickRequest` when one is available.

- Call the internal generation-transition function with that request.

- Release exactly one queue slot after the transition succeeds.

- Return `Some(TickResult)` containing the request ID, requester, and resulting metadata.


The internal generation transition must:

- Read only from the active bank.

- Compute every output cell according to the canonical rules.

- Write every output chunk to the inactive bank.

- Calculate the next population and state digest while streaming output.

- Increment the generation with checked arithmetic.

- Flip the active bank only after all output chunks have been written.

- Persist the new `WorldState` with `set_exclusive`.

- Emit one `GenerationAdvanced` event containing the consumed request's ID and requester.

- Return the resulting `WorldMetadata` to `process_next_tick()`.


The queue consume, complete world transition, queue-slot release, metadata update, and event are one atomic invocation. If any part fails, Groundhog transaction semantics must restore the request to the queue and revert all chunk writes, metadata, slot deltas, and events. Writing metadata last is useful for code clarity but is not the atomicity mechanism.

The contract must not export a direct `tick()` or `advance_world()` entrypoint. This prevents callers from bypassing request admission and correlation.
### `get_metadata`
`get_metadata()` returns a client-facing value containing:

```rust
#[contract_type]
pub struct WorldMetadata {
    pub width: u32,
    pub height: u32,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
    pub chunk_bytes: u32,
    pub chunks_per_row: u32,
    pub max_queue_len: u32,
}
```

It throws `NotInitialized` before initialization. It does not expose the inactive bank or claim to report the current queue length. A queue-depth read observes only a block snapshot and cannot include concurrent inserts, so clients must not treat it as authoritative.
### `get_chunk`
`get_chunk(row, part)` reads one chunk from the active bank.

- `row` must be less than 10,000.

- `part` must be zero or one.

- The return value is always a 1,000-byte fixed array to stay below the 1,024-byte return cap without heap allocation.

- Part zero contains 1,000 meaningful bytes.

- Part one contains 250 meaningful bytes followed by 750 zero bytes.

- Padding is a transport detail and is not part of canonical state or its digest.


The RV32 and RPC tests must confirm that the generated return encoding remains within the protocol cap.
### `get_cell`
`get_cell(x, y)` is a convenience and diagnostic method. It validates both coordinates, reads the relevant active-bank chunk, and returns the selected bit. Bulk clients should use `get_chunk`.
## Initialization Algorithm
Version one supports a deterministic 50-percent seeded soup. Initialize the SplitMix64 state to the supplied seed without normalizing zero. Each output uses this exact wrapping sequence:

```rust
fn splitmix64_next(state: &mut u64) -> u64 {
    *state = (*state).wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
```

The first output increments the initial seed before mixing.

For each successive 64-cell word:

1. Produce the next `u64` from the generator.

2. Append its little-endian bytes to the current row.

3. Count set bits with `count_ones()` and add them to the population.

4. Flush row chunks as their boundaries are reached.


The generator must continue across row boundaries rather than restarting per row. Test vectors must pin the first outputs, selected row chunks, population, and digest for at least two seeds.

Pattern uploads, selectable densities, and curated structures may be added later as versioned initialization modes. They must not change generation-zero semantics for the original mode.
## Generation Algorithm
### Streaming Order
The scalar reference kernel processes rows from zero through 9,999:

1. Load rows 9,999, 0, and 1 as `previous`, `current`, and `next`.

2. Compute destination row 0.

3. Write destination row 0 to the inactive bank.

4. Rotate the row buffers.

5. Load the next required source row from the active bank.

6. Repeat until all 10,000 rows are written.


Horizontal neighbor lookup wraps from x zero to x 9,999 and back. Vertical row selection wraps in the same way.

The three-row stream rereads source row 9,999 when it becomes the next row near the bottom, then rereads source row 0 for the final wrap. A tick therefore performs 10,002 row loads, or 20,004 chunk reads. Retaining both boundary rows would avoid 2,500 bytes of reads but increase the live RV32 working set; use the simpler reread unless profiling justifies the memory tradeoff.

At no point may a source read target the inactive bank or an output write target the active bank.
### Kernel
The first correct implementation should use a transparent scalar row kernel shared by production code and tests:

```rust
fn compute_next_row(
    previous: &[u8; ROW_BYTES],
    current: &[u8; ROW_BYTES],
    next: &[u8; ROW_BYTES],
    output: &mut [u8; ROW_BYTES],
) -> u32;
```

It returns the destination row's population. The function must clear or fully overwrite `output` before returning.

After the scalar implementation is correct and benchmarked, a bit-parallel kernel may replace it if transaction latency is unsuitable. Any optimized kernel must remain bit-for-bit equivalent to the scalar reference across randomized differential tests.
## State Digest
Every generation records a deterministic SHA-256 hash chain over its canonical chunks. This lets a client downloading the complete world verify the metadata without requiring a 12.5 MB guest buffer.

Initialize the accumulator with:

```text
SHA256("groundhog-life/world/v1" || width || height || generation)
```

The domain separator is exactly the 23 ASCII bytes `groundhog-life/world/v1`, with no terminator or length prefix. Encode `width` and `height` as four-byte big-endian `u32` values and `generation` as an eight-byte big-endian `u64` value. For each chunk in ascending `chunk_key` order, encode `chunk_key` and `actual_chunk_length` as four-byte big-endian `u32` values:

```text
leaf = SHA256(actual_chunk_bytes)
accumulator = SHA256(accumulator || chunk_key || actual_chunk_length || leaf)
```

Store the final accumulator as `state_digest`. Include actual chunk length so the 250-byte tail cannot alias a padded value.

This is a streaming world digest, not a Merkle root. It proves a complete downloaded snapshot but does not provide an efficient proof for an individual chunk. A later visualization layer may maintain a separate Merkle or aggregation index outside this first contract version.
## Queue and Crank Model
User demand is concurrent; world evolution is serial.

Any number of users may call `request_tick()` concurrently. RCQ inserts commute, as do the `NNInt` deltas used for request sequencing and queue capacity. Accepted requests can therefore enter the same block without contending on the 25 MB world state.

Request submission and queue processing must be separate transactions:

- A consumer cannot see requests inserted after its block snapshot.

- Combining insertion and consumption would make a transaction that loses the queue-consume race lose its request as well.

- Separating them keeps the small request transaction's gas budget independent from the full generation's budget.


The recommended client policy follows `helpers/batch-driver`: after a request commits, submit one `process_next_tick()` transaction with the measured full-tick gas limit and a short expiry, then stop. A keeper may also crank continuously. User cranks and a keeper compose without a privileged mode.

Only one transaction per block may consume from this RCQ. Competing crank transactions are excluded and returned to the mempool; a short expiry prevents a losing crank from executing unexpectedly much later. A crank that observes an empty queue commits no delta and conflicts with nobody.

Version one processes exactly one request per non-empty crank. This preserves a simple, auditable mapping:

```text
one consumed request -> one successful crank -> one generation -> one GenerationAdvanced event
```

Clients must not promise queue position, exact queue depth, or that their crank will process their own request. They correlate completion through `RequestId`.

An accepted request remains queued until a processing transaction succeeds, but the contract does not guarantee when that will happen. Progress requires at least one adequately funded crank to land. A global failure such as generation overflow, persistent state corruption, or an insufficient protocol limit can halt the queue at its head; version one has no privileged skip or cancellation path.
## Concurrency and Atomicity
`request_tick()` and `process_next_tick()` are permissionless.

The final `WorldState` update must use `Value::set_exclusive` even though queue consumption already serializes processors. This ensures that no two participating state transitions from the same generation can commit. Every future entrypoint that mutates world state must take the same exclusive metadata lock and preserve queue admission, or explicitly replace this concurrency design.

Chunk writes may use normal bytestring sets. The queue consume and exclusive metadata update serialize the logical transition, while Groundhog's transaction atomicity ensures losing or failed processing transactions commit no chunk writes and consume no request.

Initialization must set `WorldState` exclusively. Different concurrent initializations must not merge.
## Errors
Use an explicit contract exception with stable discriminants:

```rust
#[contract_exception]
pub enum GameOfLifeError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    CoordinateOutOfBounds = 3,
    ChunkOutOfBounds = 4,
    GenerationOverflow = 5,
    InvalidStoredState = 6,
    InvalidQueueCapacity = 7,
}
```

Expected caller errors must throw these typed variants. Missing or malformed chunk storage after initialization is contract-state corruption; translate it to `InvalidStoredState` where the SDK permits recovery, otherwise allow the storage syscall exception to abort the transaction.

Never use unchecked generation arithmetic. Deployed contracts disable overflow checks, so the internal generation transition must call `checked_add(1)` and throw `GenerationOverflow` on failure.
## Events
Emit one event when a request is accepted and one event when it produces a generation:

```rust
#[derive(Event)]
pub struct WorldInitialized {
    pub seed: u64,
    pub max_queue_len: u32,
    pub population: u64,
    pub state_digest: SHA256Hash,
}

#[derive(Event)]
pub struct TickRequested<'a> {
    #[topic]
    pub request_id: &'a RequestId,
    #[topic]
    pub requested_by: &'a ContractAddress,
}

#[derive(Event)]
pub struct GenerationAdvanced<'a> {
    #[topic]
    pub request_id: &'a RequestId,
    pub generation: u64,
    pub requested_by: &'a ContractAddress,
    pub population: u64,
    pub state_digest: SHA256Hash,
}
```

Do not emit queue-depth, per-row, per-chunk, or per-cell events. Queue depth is not authoritative during concurrent insertion, and granular world events would overwhelm the event channel.
## Internal Module Structure
Keep the contract small and separate pure computation from SDK plumbing:

```text
contracts/game-of-life/
├── Cargo.toml
├── src/
│   ├── lib.rs          # no_std boundary, exports, mock declaration
│   ├── main.rs         # RV32 binary wrapper
│   ├── contract.rs     # storage type and entrypoints
│   ├── digest.rs       # streaming digest
│   ├── kernel.rs       # cell access and next-row computation
│   ├── prng.rs         # SplitMix64 initialization
│   └── types.rs        # contract types, errors, and events
└── tests/
    ├── contract.rs     # native lifecycle and storage tests
    ├── kernel.rs       # pure correctness and differential tests
    ├── rv32.rs         # ignored on-chain-path tests
    └── integration.rs  # devnode transaction and workload tests
```

If this split creates trivial files during implementation, combine `digest.rs` and `prng.rs` into `contract.rs`. Preserve the separation between the pure kernel and storage entrypoints.
## Testing
### Pure Kernel Tests
- A dead world remains dead.

- A single live cell dies.

- A three-cell blinker oscillates with period two.

- A block remains stable.

- A glider advances correctly.

- Patterns crossing each horizontal boundary wrap correctly.

- Patterns crossing each vertical boundary wrap correctly.

- Corner patterns exercise both wraps simultaneously.

- Output buffers are fully overwritten.

- Population returned by the row kernel equals a direct bit count.

- Randomized small-world results match a deliberately simple reference model.

- An optimized kernel, if added, matches the scalar kernel bit-for-bit.


Parameterize pure helpers by dimensions where practical so correctness tests do not process 100 million cells. Keep contract constants fixed.
### Contract Tests
- Metadata and data reads throw before initialization.

- Initialization succeeds once and rejects a second call.

- Initialization rejects a zero queue capacity.

- Fixed seeds produce pinned chunks, population, and digest.

- `get_chunk` returns exact data and zero-pads only the tail.

- `get_cell` resolves first, last, and chunk-boundary coordinates.

- Concurrent `request_tick()` calls commit, produce distinct request IDs, and preserve every request.

- Queue capacity remains bounded under concurrent requests.

- A full queue excludes excess requests without committing partial request state.

- An excluded request expires without later becoming accepted when its configured lifetime ends.

- Only a committed `TickRequested` event is treated as authoritative acceptance.

- `process_next_tick()` on an empty snapshot returns `None`, emits no event, and writes no delta.

- One non-empty `process_next_tick()` consumes one request, advances one generation, and flips the active bank.

- `GenerationAdvanced` carries the same request ID and requester as `TickRequested`.

- A crank may process another caller's request; no test assumes caller-specific queue ordering.

- A full downloaded generation reproduces the stored population and digest.

- A failed generation transition leaves its request queued and leaves generation, active bank, chunks, population, digest, queue capacity, and events unchanged.

- Concurrent processing transactions cannot both consume the same request or advance the same generation.

- Request insertion and queue processing in separate transactions follow block-snapshot semantics.

- Generation overflow throws rather than wrapping.

### RV32 and Devnode Tests
- The artifact builds with `groundhog build -p game-of-life`.

- The contract runs without guest memory exhaustion.

- `get_chunk` remains under the return-value cap.

- Initialization commits 12.5 MB in one transaction.

- Many concurrent request transactions are accepted through commuting RCQ and `NNInt` deltas.

- `process_next_tick()` reads and writes the complete world in one transaction.

- Full-scale transactions override the current 10,000,000 default gas budgets with measured explicit limits.

- A non-empty processing receipt contains exactly one `GenerationAdvanced` event correlated to the consumed request.

- Competing cranks serialize safely, and excluded transactions expire or retry according to the configured short-expiry policy.

- The committed state matches native reference results for sampled chunks and the complete digest.

- Record transaction gas or compute, wall-clock execution time, storage bytes read, storage bytes written, and transaction delta size where available.


The 100-million-cell tests may be ignored in the default native suite if their runtime is excessive. They must have explicit documented commands and run in release mode and against a devnode before the example is considered complete.
## Benchmarks and Reporting
Capture at least these measurements for initialization, request admission, and one processed tick:

- Contract artifact size.

- Guest instructions or Groundhog compute units.

- Wall-clock execution time.

- Peak guest memory if available.

- Storage values read and written.

- Storage bytes read and written.

- Transaction delta and receipt sizes.

- Block inclusion and commit time.

- Final population and state digest.

- Concurrent request throughput and conflict rate.

- Crank exclusion, retry, and expiry behavior under contention.

- Required HOG storage deposit at empty and maximum queue occupancy.


Publish the seed, generation, contract artifact hash, transaction identifier, and state digest with benchmark results so another developer can reproduce them.

Do not compare operation counts with Ethereum or Solana unless the comparison documents encoding, storage, and current network limits. The strongest result is the successful atomic Groundhog transaction itself.
## Acceptance Criteria
- The contract stores a canonical 10,000 by 10,000 bit-packed world.

- Deterministic initialization materializes all 100 million cells on-chain in one invocation.

- Local setup verifies the known two-transaction deployment and initialization sequence before exposing configuration; devnet deployment remains blocked on an atomic or parameter-bound workflow.

- Concurrent tick requests use commuting RCQ inserts and bounded `NNInt` capacity deltas.

- One non-empty `process_next_tick()` invocation consumes one request and computes and commits every cell in exactly one next generation.

- Request admission and processing are intentionally separate transactions; no generation's computation or commit is split across transactions.

- No successful generation transition delegates computation off-chain.

- The world uses two banks and never overwrites source state during a generation transition.

- A failed or conflicting processing transaction commits no partial generation and does not consume its request.

- Concurrent requests are preserved, while processing transactions serialize dependent generations.

- Every completed request is correlated to exactly one `GenerationAdvanced` event.

- The contract makes no unsupported guarantee about queue position or completion latency.

- Clients can retrieve every canonical state byte through bounded chunk reads.

- Population and digest independently verify a downloaded generation.

- Native, RV32, and devnode correctness tests pass.

- A full-scale devnode benchmark records the transaction's compute and storage behavior.

## Implementation Order
1. Extend one reusable transaction harness with independent outer gas, target gas, expiry, timeout, and status controls.

2. Run the preliminary 20,004-read and 20,000-write storage-admission fixture.

3. Add pure encoding, canonical PRNG, digest, and scalar kernel modules with pinned vectors and small-world tests.

4. Add storage layout, deterministic initialization, metadata, and chunk reads.

5. Add `TickRequest`, RCQ admission, bounded queue slots, request IDs, and concurrency tests.

6. Add the internal streaming generation transition and production `process_next_tick()` entrypoint.

7. Run the final full-scale compute, memory, storage, transaction, queue-consume, metadata, and event feasibility gate through the production entrypoint.

8. Add the known two-transaction local deployment, initialization, verification, and prefunding workflow.

9. Add RV32 and devnode full-scale request, contention, and processing tests.

10. Benchmark the scalar kernel and complete crank path.

11. Add a bit-parallel kernel only if measured latency warrants it.

12. Document reproducible deployment, initialization, request, crank, retrieval, and verification commands.

## Open Questions
- What are the node's hard limits on storage writes, transaction deltas, and block payloads?

- What gas limit and client timeout are required for a full tick?

- What queue capacity balances crowd participation against the contract's storage deposit and acceptable wait time?

- What short expiry height should frontend-submitted crank transactions use?

- What expiry height should request transactions use when a full queue can defer admission?

- How much HOG must deployment provision for two world banks and maximum queue occupancy?

- Does the devnode expose peak memory and storage-byte metrics in receipts or traces?

- Is the 1,024-byte return cap applied before or after generated return encoding, and does `[u8; 1000]` leave sufficient headroom on every target?

- Does a 12.5 MB transaction delta create unacceptable replication, persistence, or RPC latency even when execution succeeds?

- Is the scalar kernel fast enough for the intended live demo, or is a bit-parallel implementation required?
