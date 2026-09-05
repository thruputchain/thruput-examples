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

const TARGET_GAS = gasAmount(10_000_000n);

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
