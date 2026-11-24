// The gas a crank (`process_requests`) declares. It is what the driver advises
// for a batch of MIN_CRANK_BATCH (8): `gas_for_batch(8)`
// = EPILOGUE_GAS + CLAIM_GAS + 9 * REQUEST_GAS_MAX
// = 200_000 + 100_000 + 9 * 1_500_000. A crank facing a backlog of eight or more
// is refused below CLAIM_GAS + `budget_for_batch(8)` (12.3M), so this clears
// that floor with a request's worth to spare, and in practice drains well past
// eight because a request costs far less than the cap it declares.
//
// Those constants are Rust (`swap-if`, `batch-driver`) and cannot be imported
// here, so this figure is copied by hand.
export const CRANK_FRAME_GAS = 13_800_000n;
