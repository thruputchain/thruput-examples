import type { ContractAddress } from "@groundhogchain/protocol";

export interface OrderedTokens {
  token0: ContractAddress;
  token1: ContractAddress;
  inputIndex: 0 | 1;
}

export interface OrientedReserves {
  reserveIn: bigint;
  reserveOut: bigint;
}

export function orderTokens(
  tokenIn: ContractAddress,
  tokenOut: ContractAddress,
): OrderedTokens {
  const comparison = compareBytes(tokenIn, tokenOut);
  if (comparison === 0) {
    throw new Error("Input and output tokens must differ");
  }
  return comparison < 0
    ? { token0: tokenIn, token1: tokenOut, inputIndex: 0 }
    : { token0: tokenOut, token1: tokenIn, inputIndex: 1 };
}

export function orientReserves(
  reserves: readonly [bigint, bigint],
  inputIndex: 0 | 1,
): OrientedReserves {
  return inputIndex === 0
    ? { reserveIn: reserves[0], reserveOut: reserves[1] }
    : { reserveIn: reserves[1], reserveOut: reserves[0] };
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) {
    throw new Error("Token addresses must have equal lengths");
  }
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
