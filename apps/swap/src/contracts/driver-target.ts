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

// Temporary budget for the deployed 2M/request cap and eight-request minimum:
// gas_for_batch(8) is 18.05M. Keep headroom until live calibration is complete.
const TARGET_GAS = gasAmount(20_000_000n);

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
