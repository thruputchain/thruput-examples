import type { ContractView, ThruputClient } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";

import { SwapHandler } from "./generated/swap-handler";

interface PoolState {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestamp: bigint;
  liquidity: bigint;
  liquidityToken: ContractAddress;
  cumulativePrices: readonly [bigint, bigint];
}

export interface SwapHandlerReadAdapter {
  poolState(): Promise<ContractView<PoolState>>;
}

export function createSwapHandlerReadAdapter(params: {
  client: Pick<ThruputClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): SwapHandlerReadAdapter {
  return {
    async poolState() {
      const result = await SwapHandler.v0_1.poolState.view({
        client: params.client,
        contract: params.contract,
        caller: params.caller,
      });
      const [reserve0, reserve1] = result.value.reserves;
      return {
        ...result,
        value: {
          reserve0,
          reserve1,
          blockTimestamp: result.value.block_timestamp,
          liquidity: result.value.liquidity,
          liquidityToken: result.value.liquidity_token,
          cumulativePrices: result.value.cumulative_prices,
        },
      };
    },
  };
}
