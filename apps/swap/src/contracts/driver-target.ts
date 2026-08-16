import {
  gasAmount,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";

import { SwapDriver } from "@/contracts/generated/swap-driver";

const TARGET_GAS = gasAmount(10_000_000n);

export function buildProcessRequestsTarget(driver: ContractAddress): Invocation {
  return SwapDriver.processRequests.invocation(driver, TARGET_GAS);
}
