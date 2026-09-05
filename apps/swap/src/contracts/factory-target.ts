import { gasAmount, type ContractAddress, type Invocation } from "@groundhogchain/protocol";

import { SwapFactory } from "@/contracts/generated/swap-factory";

const TARGET_GAS = gasAmount(10_000_000n);

export function buildCreatePairTarget(
  factory: ContractAddress,
  tokenA: ContractAddress,
  tokenB: ContractAddress,
  funding: bigint,
): Invocation {
  if (funding <= 0n) throw new RangeError("Pool funding must be positive");
  return SwapFactory.createPair.invocation(factory, TARGET_GAS, {
    tokenA,
    tokenB,
    funding,
  });
}
