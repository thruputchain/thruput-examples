import {
  gasAmount,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";

import { SwapRouter } from "@/contracts/generated/swap-router";

const TARGET_GAS = gasAmount(10_000_000n);

export interface ExactInputSwapRequest {
  amountIn: bigint;
  amountOutMin: bigint;
  tokenIn: ContractAddress;
  tokenOut: ContractAddress;
  recipient: ContractAddress;
}

export function buildExactInputSwapTarget(
  router: ContractAddress,
  request: ExactInputSwapRequest,
): Invocation {
  return SwapRouter.swapExactTokensForTokens(router, TARGET_GAS, request);
}
