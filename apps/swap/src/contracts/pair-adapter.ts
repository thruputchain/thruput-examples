import type { GroundhogClient } from "@groundhogchain/client";
import { gasAmount, type ContractAddress } from "@groundhogchain/protocol";

import { SwapPair, spec } from "@/contracts/generated/swap-pair";
import { type ContractView, viewMethod } from "@/contracts/view";
import { orientReserves, orderTokens } from "@/domain/tokens";

const VIEW_GAS = gasAmount(10_000_000n);

export interface PairReserves {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestamp: bigint;
}

export interface SwapPairReadAdapter {
  reserves(): Promise<ContractView<PairReserves>>;
  reservesFor(
    tokenIn: ContractAddress,
    tokenOut: ContractAddress,
  ): Promise<ContractView<{ reserveIn: bigint; reserveOut: bigint }>>;
}

export function createSwapPairReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): SwapPairReadAdapter {
  const reserves = () =>
    viewMethod({
      client: params.client,
      invocation: SwapPair.getReserves(params.contract, VIEW_GAS),
      caller: params.caller,
      spec,
      interfaceName: "SwapPair",
      methodName: "get_reserves",
      validate: expectReserves,
    });

  return {
    reserves,
    async reservesFor(tokenIn, tokenOut) {
      const current = await reserves();
      return {
        value: orientReserves(
          [current.value.reserve0, current.value.reserve1],
          orderTokens(tokenIn, tokenOut).inputIndex,
        ),
        height: current.height,
      };
    },
  };
}

function expectReserves(value: unknown): PairReserves {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => typeof item !== "bigint")
  ) {
    throw new TypeError("SwapPair.get_reserves returned an invalid tuple");
  }
  return {
    reserve0: value[0] as bigint,
    reserve1: value[1] as bigint,
    blockTimestamp: value[2] as bigint,
  };
}
