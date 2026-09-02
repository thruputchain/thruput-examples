# Swap App: Pending Contract Changes

The `swap-*` contracts were reworked in five rounds: the identities behind an
operation were separated, queue-cranking became permissionless with the cranker
sizing its own batch, the pair was collapsed into the handler, the call chain
from router to pair was permissioned, and pool creation became a single funded
transaction.  This is the list of what changed and what it means for the
frontend.

The reasoning behind the contract side is in
[`docs/README-swap.md`](docs/README-swap.md) ("Why a Request Queue", "Cranking
the Queue") and in the [`batch-driver`](helpers/batch-driver/src/lib.rs) module
docs; the constants carry their own measured justifications.

**The app is now broken against these contracts**, in four ways, which are the
first four sections below.  There is no pair contract any more
([Collapsing the pair](#collapsing-the-pair-into-the-handler)); the event the
app watches no longer says what it used to
([Sender and recipient](#sender-and-recipient)); local setup brings the
contracts up in an order the factory no longer accepts
([The call chain is permissioned](#the-call-chain-is-permissioned)); and a pool
is now created by asking the factory for one rather than by adding liquidity
([Creating a pool](#creating-a-pool-is-one-funded-call)).  The cranking items
after those are things to take up rather than breakage.

The app's own runtime paths -- submitting through the router, cranking through
the driver -- are otherwise intact: what broke is what it reads, and how setup
wires things together.

## Sender and recipient

An operation's payer and its beneficiary are now tracked separately all the way
through, so an event says both.  One consequence reaches the app, and it is not
the one the commit's own summary leads with.

* **The `sender` topic on `SwapEvent` is the user, not the handler.**  It used
  to be `get_caller()` as seen from inside the pair -- which, since only the
  handler ever called the pair, was always the handler's address.  It is now
  the trader the router recorded.  The observer filters on the old meaning in
  two places, `sender: config.handlerAddress` in the `GeneratedSwapEvent.filter`
  and the matching `bytesEqual(swap.topics.sender, handlerAddress)` in
  `matchSwapEvent`; both want the user's address, which is already to hand as
  `config.accountAddress` beside the `recipient` topic they filter on.

  This one fails quietly: the filter simply matches nothing, so every request
  sits unobserved until it times out.

* **`MintEvent` gains a `recipient` topic.**  Bindings-only for this app, which
  decodes `SwapEvent` and nothing else -- worth knowing when regenerating, not
  work in itself.  (`BurnEvent` and `SwapEvent` already carried one.)

## Collapsing the pair into the handler

`swap-pair` is no longer a contract.  Its operations are performed by the
handler, in the handler's own invocation, against state and tokens the handler
holds -- so **the handler is the pool**: it answers for the reserves, mints and
burns the LP token, and emits the events those operations produce.  A pool is
three contracts now (LP token, handler, driver) rather than four.

* **`VITE_SWAP_PAIR_ADDRESS` goes away**, along with `config.pairAddress`.
  Everywhere the app used the pair's address it wants the handler's, which it
  already has as `config.handlerAddress`.

* **Reserves come from the handler, in one call.**
  [`pair-adapter.ts`](apps/swap/src/contracts/pair-adapter.ts) and
  [`setup-local.ts`](apps/swap/scripts/setup-local.ts) call
  `SwapPair.getReserves`.  The pair's four read-only views are now a single
  `SwapHandler.poolState()`, returning a struct:

  ```
  PoolState { reserves, block_timestamp, liquidity, liquidity_token, cumulative_prices }
  ```

  So a caller that wanted reserves *and* supply -- as `setup-local.ts` does --
  makes one view call rather than several.

  The generated `swap-pair.ts` should be deleted and a `swap-handler.ts`
  generated in its place -- the handler had no views worth binding before, so
  there is no such file yet.

* **Mint, Burn and Swap events are emitted by the handler.**  This is the one
  most likely to pass a type-check and then quietly observe nothing:
  [`request-observer.ts`](apps/swap/src/transactions/request-observer.ts)
  filters them with `contractAddresses: [config.pairAddress]` and compares
  `event.contractAddress` against it in three more places.  All of those become
  the handler's address.  `SyncEvent` still comes from the pair's code, which
  now also runs there, so it moves too.

* **`Pool` and `SwapHashes` lose their `pair` field**, and `PoolCreated` loses
  it too.  In `setup-local.ts` that reaches four places: the `Artifacts`
  interface and the `contract("swap_pair.rv32a")` that loads a binary which is
  no longer built, the `pair:` hash passed to `SwapFactory.initialize`, the
  `[liquidity_token, pair, handler, driver]` funding loop, and the
  `VITE_SWAP_PAIR_ADDRESS` line written into `.env.local`.

* **`generate-contract-bindings.sh` still builds and binds the pair.**  It
  should drop the `swap-pair` build and codegen, and add `swap-handler` --
  which will fail at the build step first, since `swap-pair` no longer produces
  a guest binary.

* **`SwapHandler::initialize` takes `(factory, token0, token1, lp_token)`.**
  Still not called by the app -- the factory does it -- but the handler now
  adopts the LP token itself rather than asking a pair for it.

* **New error types.**  `SwapRouterError` and two more `SwapDriverError`
  variants (`AlreadyInitialized`, `InvalidConfiguration`) replace what were
  `panic!`s, so a failed initialization now arrives as a declared exception
  rather than an undifferentiated fault.

## The call chain is permissioned

A `SwapRequest` names the account whose tokens it will spend, and the handler
spends them on that account's standing allowance.  Nothing downstream can check
that claim -- the router is what sees the account making the call -- so each
link now takes work from its predecessor alone: the driver enqueues only for the
router, and the handler handles only for its driver.  Without that, anyone could
enqueue a request naming a victim as the payer and themselves as the recipient,
and be paid out of the victim's approval.

**The app's runtime paths are unaffected.**  Submissions already go through the
router (`swapExactTokensForTokens`, `addLiquidity`), and `processRequests` stays
open to anyone -- cranking is still permissionless.  What changes is setup.

* **`SwapFactory::initialize` takes a `router`**, which it passes to every
  driver it creates.  So **the router must be deployed before the factory is
  initialized**, and `setup-local.ts` currently does neither in that order: step
  4 deploys *and* initializes the factory, step 5 deploys *and* initializes the
  router.  Those have to interleave -- deploy the factory, deploy the router,
  initialize the factory naming the router, then initialize the router naming
  the factory.  Both addresses are known once deployed, so nothing else has to
  move.

* **`SwapDriver::initialize` gains a `router`, and `SwapHandler::initialize` a
  `driver`.**  Bindings-only for the app, which calls neither: the factory
  wires the pool up when it creates it.

* **Two new `Unauthorized` errors** -- `SwapDriverError::Unauthorized` from
  `request`, and `SwapRequestError::Unauthorized` from `handle_request`.  The
  app should not provoke either, but they are what a mis-wired deployment will
  produce, so they are worth recognising: they mean the caller is not the
  contract's designated predecessor, not that anything was wrong with the
  request.

## Creating a pool is one funded call

A pool's three contracts each pay for their own storage, so each needs HOG
before it writes any.  `create_pair` now does that itself: it takes `funding`,
moves that much to each of the three addresses, deploys them, and initializes
them -- funding, deployment and wiring in the one transaction.

The HOG comes from the caller, on an allowance granted to the factory
beforehand; taking it from the factory's own balance would let anyone drain the
factory by creating pools.

* **`SwapFactory::create_pair` gains a `funding` argument**, and wants an
  allowance: `adjust_allowance(HOG, factory, 3 * funding)` on the native token,
  then `create_pair(tokenA, tokenB, funding)`.

* **`SwapFactory::pool_funding` is new**, and answers what to pass: a
  `PoolFunding { min, recommended }`, per contract.  Under the default cost
  model that is `{ 128_000, 10_000_000 }` -- the floor covers bringing a pool
  up and filling its queue, the recommendation leaves room for some 800 storage
  items per contract.  Both depend on the chain's cost model, so ask rather
  than hard-coding: `pool_funding()`, then grant `3 * recommended` and pass
  `recommended`.  Below `min`, `create_pair` throws
  `SwapFactoryError::InsufficientFunding`.

* **`setup-local.ts` step 6 goes away.**  It reads `poolAddresses` and sends the
  faucet at each of four predicted addresses (one of which, `pool.pair`, no
  longer exists) so that a later `addLiquidity` can deploy into them.  Replace
  the whole loop with the allowance and the `create_pair` call above; the
  approve-and-add-liquidity steps that follow are unchanged, and `poolAddresses`
  is still how the app learns the handler, driver and LP token.

* **The router no longer creates pools.**  UniswapV2's router creates a pair on
  the first `addLiquidity`; ours will not, because creating one now spends the
  caller's HOG, which is not a thing to do as a side effect of adding
  liquidity.  Every router operation -- `addLiquidity`, `removeLiquidity`, and
  both swaps -- now resolves its pair against the factory's registry and throws
  `SwapRouterError::NoSuchPair` (new, code 2) if it is not there, instead of
  calling an address with nothing behind it.  Since setup now creates the pool
  explicitly, the app only meets this if it routes to a pair nobody made.

* **Under-funding past the floor reports nothing.**  A storage deposit is
  settled when the transaction commits, so a `funding` that clears the floor but
  does not cover bring-up cannot be caught inside `create_pair`.  The
  transaction fails reservation instead: it goes back to the mempool, retries,
  keeps failing, and expires with no pool and no error.  A `create_pair` that
  never lands and never aborts means the funding was too small, not that the
  node lost it.

## Cranking

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
| The pair's operations, now library code | [`engines/swap-pair/src/pair.rs`](engines/swap-pair/src/pair.rs) |
| The pool: the handler that runs them and emits their events | [`contracts/swap-handler/src/handler.rs`](contracts/swap-handler/src/handler.rs) |
| The drain loop, its gas budgeting, and the queue ceiling | [`helpers/batch-driver/src/lib.rs`](helpers/batch-driver/src/lib.rs) |
| The driver: enqueue, ceiling, drain, summary event | [`contracts/swap-driver/src/driver.rs`](contracts/swap-driver/src/driver.rs) |
| The interface and its events | [`interfaces/swap-if/src/driver.rs`](interfaces/swap-if/src/driver.rs), [`interfaces/swap-if/src/events.rs`](interfaces/swap-if/src/events.rs) |
| The queue ceiling a pool is created with | `MAX_QUEUE_LEN` in [`contracts/swap-factory/src/factory.rs`](contracts/swap-factory/src/factory.rs) |
| What the contracts guarantee, as tests | `helpers/batch-driver/tests/`, `contracts/swap-driver/tests/` |
