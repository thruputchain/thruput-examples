import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { orderTokens } from "@/domain/tokens";

export type ParsedPoolRoute =
  | {
      kind: "canonical";
      token0: ContractAddress;
      token1: ContractAddress;
      token0Hex: string;
      token1Hex: string;
    }
  | { kind: "redirect"; token0Hex: string; token1Hex: string }
  | { kind: "invalid" };

export function parsePoolRoute(
  token0Value: string | undefined,
  token1Value: string | undefined,
): ParsedPoolRoute {
  if (token0Value === undefined || token1Value === undefined) {
    return { kind: "invalid" };
  }
  let token0: ContractAddress;
  let token1: ContractAddress;
  try {
    token0 = addressFromHex(token0Value);
    token1 = addressFromHex(token1Value);
  } catch {
    return { kind: "invalid" };
  }
  if (isZero(token0) || isZero(token1)) return { kind: "invalid" };
  let ordered: ReturnType<typeof orderTokens>;
  try {
    ordered = orderTokens(token0, token1);
  } catch {
    return { kind: "invalid" };
  }
  if (ordered.inputIndex !== 0) return { kind: "invalid" };
  const canonical0 = toHex0x(ordered.token0);
  const canonical1 = toHex0x(ordered.token1);
  if (token0Value !== canonical0 || token1Value !== canonical1) {
    return { kind: "redirect", token0Hex: canonical0, token1Hex: canonical1 };
  }
  return {
    kind: "canonical",
    token0: ordered.token0,
    token1: ordered.token1,
    token0Hex: canonical0,
    token1Hex: canonical1,
  };
}

export function poolPath(
  token0: ContractAddress,
  token1: ContractAddress,
  suffix = "",
): string {
  const ordered = orderTokens(token0, token1);
  return `/pools/${toHex0x(ordered.token0)}/${toHex0x(ordered.token1)}${suffix}`;
}

function isZero(address: ContractAddress): boolean {
  return address.every((byte) => byte === 0);
}
