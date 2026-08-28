# Swap App: Pending Contract Changes

The `swap-*` contracts were reworked so that queue-cranking is permissionless
and the cranker sizes its own batch.  This is the list of what changed and what
it means for the frontend.

The reasoning behind the contract side is in
[`docs/README-swap.md`](docs/README-swap.md) ("Why a Request Queue", "Cranking
the Queue") and in the [`batch-driver`](helpers/batch-driver/src/lib.rs) module
docs; the constants carry their own measured justifications.

Nothing here breaks the app as it stands.  The stale bindings still hold the
right entrypoint ids, and the app never calls the one method whose signature
changed.

## What changed

* **Regenerate the bindings.**
  [`apps/swap/src/contracts/generated/swap-driver.ts`](apps/swap/src/contracts/generated/swap-driver.ts)
  no longer matches the driver's spec. Nothing is broken meanwhile: entrypoint
  ids derive from the method name alone, so the ids in the checked-in file --
  and `SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT` in the generated `.env.local`
  -- are still correct.

* **`SwapDriver::initialize` takes a `max_queue_len` and a
  `min_crank_batch`.**  A bindings-only change for the app, which never calls
  it: the factory initializes each driver on-chain when it creates the pool,
  passing its own defaults.

* **New event: `RequestsProcessed { processed: u32, failed: u32 }`.**  Emitted
  once per batch that took anything, and attributed (like every event) to the
  driver's own address, which is what distinguishes one pair's batches from
  another's.  A crank receipt carrying it says in one place what the crank did,
  rather than requiring a tally of the terminal events in it.  A crank that
  found the queue empty emits nothing.

* **The crank's declared gas limit now chooses the batch size.**  `TARGET_GAS`
  in [`apps/swap/src/contracts/driver-target.ts`](apps/swap/src/contracts/driver-target.ts)
  (10M) used to be a safe over-declaration against a fixed ceiling of about ten
  requests; it now selects the batch -- about sixteen, if every request costs
  the full `REQUEST_GAS_MAX`, and more when they cost less.  Since the declared
  limit is also the throughput capacity the scheduler charges under congestion,
  it is now worth choosing deliberately: small for a user cranking to hurry its
  own request along, large for draining a backlog.  The Rust-side sizing helper
  is `swap_driver::process_requests_gas(batch_size)`.

* **A crank can be refused as too small.**  A crank must be able to drain
  whatever is waiting, up to the pool's `min_crank_batch`; one that cannot
  aborts with `SwapDriverError::BatchTooSmall` rather than spending the block's
  only drain on less.  `TARGET_GAS` is far above the floor, so this does not
  bite as things stand -- but an in-app control that ever lets a user pick a
  small batch has to handle the refusal, and should read it as "ask for more"
  rather than as a failed crank.

* **A request submission can now be *deferred*.**  With the queue at its
  ceiling, a `request` transaction is excluded from its block and returned to
  the mempool rather than failing, so it may land a block or more later, or
  expire unfulfilled.  Before assuming the existing committed/failed split in
  `outcomeFromReceipt` covers this, confirm against a devnode how an excluded
  transaction surfaces through the RPC status API: it is in no block at all, so
  it ought to read as not-yet-observed rather than as a committed failure --
  but that is worth seeing rather than assuming.  A submission's expiry height
  is what bounds the wait.

* **The shell crank does not choose a batch size.**
  [`crank-local.sh`](apps/swap/scripts/crank-local.sh) invokes `groundhog call`,
  which has no gas-limit flag and declares its own default.  Harmless against a
  local devnode, where nothing competes for throughput, but the in-app crank
  should choose deliberately rather than copy the fallback.

* **A committed crank returning `(0, 0)` is ordinary**, not an error: it means
  the queue was empty at that block's snapshot, or another crank got there
  first.  The app's existing rule that a successful crank does not prove any
  particular request reached a terminal state (see
  [2026-08-14-swap-multi-request](docs/specs/2026-08-14-swap-multi-request.md))
  already covers it.

## Where to look

| | |
|---|---|
| The drain loop, its gas budgeting, and the queue ceiling | [`helpers/batch-driver/src/lib.rs`](helpers/batch-driver/src/lib.rs) |
| The driver: enqueue, ceiling, drain, summary event | [`contracts/swap-driver/src/driver.rs`](contracts/swap-driver/src/driver.rs) |
| The interface and its events | [`interfaces/swap-if/src/driver.rs`](interfaces/swap-if/src/driver.rs), [`interfaces/swap-if/src/events.rs`](interfaces/swap-if/src/events.rs) |
| The queue ceiling a pool is created with | `MAX_QUEUE_LEN` in [`contracts/swap-factory/src/factory.rs`](contracts/swap-factory/src/factory.rs) |
| What the contracts guarantee, as tests | `helpers/batch-driver/tests/`, `contracts/swap-driver/tests/` |
