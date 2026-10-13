import {
  gasAmount,
  type ContractAddress,
  type Invocation,
} from "@thruputchain/protocol";

import { SwapRouter } from "@/contracts/generated/swap-router";

const TARGET_GAS = gasAmount(10_000_000n);

export interface ExactInputSwapRequest {
  amountIn: bigint;
  amountOutMin: bigint;
  tokenIn: ContractAddress;
  tokenOut: ContractAddress;
  recipient: ContractAddress;
}

export interface AddLiquidityRequest {
  token0: ContractAddress;
  token1: ContractAddress;
  amountsDesired: readonly [bigint, bigint];
  amountsMin: readonly [bigint, bigint];
  recipient: ContractAddress;
}

export interface RemoveLiquidityRequest {
  token0: ContractAddress;
  token1: ContractAddress;
  liquidity: bigint;
  amountsMin: readonly [bigint, bigint];
  recipient: ContractAddress;
}

export function buildAddLiquidityTarget(
  router: ContractAddress,
  request: AddLiquidityRequest,
): Invocation {
  if (
    request.amountsDesired.some((amount) => amount <= 0n)
    || request.amountsMin.some((amount, index) =>
      amount <= 0n || amount > request.amountsDesired[index]!
    )
  ) {
    throw new RangeError("Liquidity amounts and minimums must be positive and bounded");
  }
  return SwapRouter.v0_1.addLiquidity.invocation(router, TARGET_GAS, {
    tokenA: request.token0,
    tokenB: request.token1,
    amountsDesired: request.amountsDesired,
    amountsMin: request.amountsMin,
    recipient: request.recipient,
  });
}

export function buildRemoveLiquidityTarget(
  router: ContractAddress,
  request: RemoveLiquidityRequest,
): Invocation {
  if (request.liquidity <= 0n || request.amountsMin.some((amount) => amount <= 0n)) {
    throw new RangeError("Liquidity and minimum outputs must be positive");
  }
  return SwapRouter.v0_1.removeLiquidity.invocation(router, TARGET_GAS, {
    tokenA: request.token0,
    tokenB: request.token1,
    liquidity: request.liquidity,
    amountsMin: request.amountsMin,
    recipient: request.recipient,
  });
}

export function buildExactInputSwapTarget(
  router: ContractAddress,
  request: ExactInputSwapRequest,
): Invocation {
  return SwapRouter.v0_1.swapExactTokensForTokens.invocation(
    router,
    TARGET_GAS,
    request,
  );
}
