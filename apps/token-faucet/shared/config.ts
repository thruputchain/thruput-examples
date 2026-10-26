import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";

export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  claimAmount: string;
}
export interface PublicConfig {
  networkId: string;
  anchorHeight: string;
  anchorHash: string;
  faucetAddress: string;
  tokens: Token[];
  cooldownSeconds: number;
  swapUrl: string;
}
export interface Claim {
  id: string;
  recipient: string;
  status: "reserved" | "pending" | "confirmed" | "failed";
  hash: string | null;
  createdAt: number;
  retryAt: number;
}

export function address(value: string): string {
  const bytes = addressFromBase58(value);
  if (toBase58(bytes) !== value || bytes.every((b) => b === 0))
    throw new Error("Enter a nonzero base58 wallet address.");
  return value;
}
export function hash(value: string): string {
  if (toBase58(hashFromBase58(value)) !== value)
    throw new Error("Expected a canonical base58 hash.");
  return value;
}
export function parseTokens(value: unknown): Token[] {
  if (!Array.isArray(value) || value.length !== 6)
    throw new Error("Configure six starter-pack tokens.");
  const tokens = value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("address" in item) ||
      typeof item.address !== "string" ||
      !("symbol" in item) ||
      typeof item.symbol !== "string" ||
      !/^t[A-Z]{3,5}$/.test(item.symbol) ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      item.name.length > 64 ||
      !item.name ||
      !("decimals" in item) ||
      !Number.isInteger(item.decimals) ||
      typeof item.decimals !== "number" ||
      item.decimals < 0 ||
      item.decimals > 18 ||
      !("claimAmount" in item) ||
      typeof item.claimAmount !== "string" ||
      !/^[1-9][0-9]{0,30}$/.test(item.claimAmount)
    )
      throw new Error("Invalid starter-pack token configuration.");
    return {
      address: address(item.address),
      symbol: item.symbol,
      name: item.name,
      decimals: item.decimals,
      claimAmount: item.claimAmount,
    };
  });
  if (
    new Set(tokens.map((t) => t.address)).size !== tokens.length ||
    new Set(tokens.map((t) => t.symbol)).size !== tokens.length
  )
    throw new Error("Starter-pack tokens must be unique.");
  return tokens;
}
