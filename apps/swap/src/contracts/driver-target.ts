import {
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  gasAmount,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";

import {
  RequestsProcessed,
  SwapDriver,
} from "@/contracts/generated/swap-driver";

// What the driver advises for a batch of MIN_CRANK_BATCH (8): `gas_for_batch(8)`
// = EPILOGUE_GAS + 9 * REQUEST_GAS_MAX = 200_000 + 9 * 1_500_000. A crank facing
// a backlog of eight or more is refused below `budget_for_batch(8)` (12.2M), so
// this clears that floor with a request's worth to spare, and in practice drains
// well past eight because a request costs far less than the cap it declares.
//
// Those constants are Rust (`swap-if`, `batch-driver`) and cannot be imported
// here, so this figure is copied by hand; `scripts/swap-gas-calibrate.sh`
// measures what they should be.
export const CRANK_FRAME_GAS = 13_700_000n;

const TARGET_GAS = gasAmount(CRANK_FRAME_GAS);

export function buildProcessRequestsTarget(driver: ContractAddress): Invocation {
  return SwapDriver.processRequests.invocation(driver, TARGET_GAS);
}

export function decodeRequestsProcessedSummary(
  receipt: TransactionReceipt,
  driver: ContractAddress,
): { processed: bigint; failed: bigint } | null {
  const summaries = RequestsProcessed.allFromReceipt(receipt, {
    contractAddress: driver,
  });
  if (summaries.length === 0) return null;
  if (summaries.length !== 1) {
    throw new Error("Queue receipt contains multiple processing summaries");
  }
  return summaries[0]!.fields;
}
