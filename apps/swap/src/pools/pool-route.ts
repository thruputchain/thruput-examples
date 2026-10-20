import { addressFromBase58, toBase58 } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";

import { orderTokens } from "@/domain/tokens";
import { typedAddress } from "@/lib/address";

export type ParsedPoolRoute =
  | {
      kind: "canonical";
      token0: ContractAddress;
      token1: ContractAddress;
      token0Base58: string;
      token1Base58: string;
    }
  | { kind: "redirect"; token0Base58: string; token1Base58: string }
  | { kind: "invalid" };

export function parsePoolRoute(
  token0Value: string | undefined,
  token1Value: string | undefined,
): ParsedPoolRoute {
  if (token0Value === undefined || token1Value === undefined) {
    return { kind: "invalid" };
  }
  // Route segments may be base58 or C StrKey; links always use base58.
  const text0 = typedAddress(token0Value);
  const text1 = typedAddress(token1Value);
  if (text0 === null || text1 === null) return { kind: "invalid" };
  const token0 = addressFromBase58(text0);
  const token1 = addressFromBase58(text1);
  if (isZero(token0) || isZero(token1)) return { kind: "invalid" };
  let ordered: ReturnType<typeof orderTokens>;
  try {
    ordered = orderTokens(token0, token1);
  } catch {
    return { kind: "invalid" };
  }
  if (ordered.inputIndex !== 0) return { kind: "invalid" };
  const canonical0 = toBase58(ordered.token0);
  const canonical1 = toBase58(ordered.token1);
  if (token0Value !== canonical0 || token1Value !== canonical1) {
    return {
      kind: "redirect",
      token0Base58: canonical0,
      token1Base58: canonical1,
    };
  }
  return {
    kind: "canonical",
    token0: ordered.token0,
    token1: ordered.token1,
    token0Base58: canonical0,
    token1Base58: canonical1,
  };
}

export function poolPath(
  token0: ContractAddress,
  token1: ContractAddress,
  suffix = "",
): string {
  const ordered = orderTokens(token0, token1);
  return `/pools/${toBase58(ordered.token0)}/${toBase58(ordered.token1)}${suffix}`;
}

function isZero(address: ContractAddress): boolean {
  return address.every((byte) => byte === 0);
}
