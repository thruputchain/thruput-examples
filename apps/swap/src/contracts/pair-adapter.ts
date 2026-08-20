import type { ContractView, GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { SwapPair } from "@/contracts/generated/swap-pair";

export interface PairReserves {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestamp: bigint;
}

export interface SwapPairReadAdapter {
  reserves(): Promise<ContractView<PairReserves>>;
}

export function createSwapPairReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): SwapPairReadAdapter {
  return {
    async reserves() {
      const result = await SwapPair.getReserves.view({
        client: params.client,
        contract: params.contract,
        caller: params.caller,
      });
      const [reserve0, reserve1, blockTimestamp] = result.value;
      return {
        ...result,
        value: { reserve0, reserve1, blockTimestamp },
      };
    },
  };
}
