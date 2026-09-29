import type { ContractView, GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { SwapFactory } from "@/contracts/generated/swap-factory";

export interface PoolAddresses {
  liquidityToken: ContractAddress;
  handler: ContractAddress;
  driver: ContractAddress;
}

export interface PoolFunding {
  min: bigint;
  recommended: bigint;
}

export interface SwapFactoryReadAdapter {
  allPairsLength(): Promise<ContractView<bigint>>;
  pairAt(index: bigint): Promise<ContractView<readonly [ContractAddress, ContractAddress] | null>>;
  getPair(
    tokenA: ContractAddress,
    tokenB: ContractAddress,
  ): Promise<ContractView<ContractAddress | null>>;
  poolAddresses(
    tokenA: ContractAddress,
    tokenB: ContractAddress,
  ): Promise<ContractView<PoolAddresses>>;
  poolFunding(): Promise<ContractView<PoolFunding>>;
  feeTo(): Promise<ContractView<ContractAddress | null>>;
}

export function createSwapFactoryReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): SwapFactoryReadAdapter {
  const context = {
    client: params.client,
    contract: params.contract,
    caller: params.caller,
  };
  return {
    allPairsLength() {
      return SwapFactory.v0_1.allPairsLength.view(context);
    },
    pairAt(index) {
      return SwapFactory.v0_1.pairAt.view({ ...context, args: { index } });
    },
    getPair(tokenA, tokenB) {
      return SwapFactory.v0_1.getPair.view({
        ...context,
        args: { tokenA, tokenB },
      });
    },
    async poolAddresses(tokenA, tokenB) {
      const result = await SwapFactory.v0_1.poolAddresses.view({
        ...context,
        args: { tokenA, tokenB },
      });
      return {
        ...result,
        value: {
          liquidityToken: result.value.liquidity_token,
          handler: result.value.handler,
          driver: result.value.driver,
        },
      };
    },
    poolFunding() {
      return SwapFactory.v0_1.poolFunding.view(context);
    },
    feeTo() {
      return SwapFactory.v0_1.feeTo.view(context);
    },
  };
}
