import { MAX_SIGNED_AMOUNT } from "../../shared/amount";

const encoder = new TextEncoder();

export interface TokenDraft {
  name: string;
  symbol: string;
  decimals: string;
  supply: string;
}
export interface ParsedToken {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: bigint;
}
export type TokenErrors = Partial<Record<keyof TokenDraft, string>>;

export function parseTokenDraft(draft: TokenDraft): {
  value?: ParsedToken;
  errors: TokenErrors;
} {
  const errors: TokenErrors = {};
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  if (encoder.encode(name).length < 1 || encoder.encode(name).length > 100)
    errors.name = "Use 1 to 100 UTF-8 bytes.";
  if (encoder.encode(symbol).length < 1 || encoder.encode(symbol).length > 10)
    errors.symbol = "Use 1 to 10 UTF-8 bytes.";
  const decimals = /^\d+$/.test(draft.decimals) ? Number(draft.decimals) : NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    errors.decimals = "Use a whole number from 0 to 18.";
  let initialSupply = 0n;
  if (!/^\d+(?:\.\d+)?$/.test(draft.supply))
    errors.supply = "Use a non-negative decimal amount.";
  else if (!errors.decimals) {
    const [whole = "0", fraction = ""] = draft.supply.split(".");
    if (fraction.length > decimals)
      errors.supply = `Use no more than ${decimals} decimal places.`;
    else {
      initialSupply =
        BigInt(whole) * 10n ** BigInt(decimals) +
        BigInt(fraction.padEnd(decimals, "0") || "0");
      if (initialSupply > MAX_SIGNED_AMOUNT)
        errors.supply = "The supply exceeds the signed 128-bit limit.";
    }
  }
  return Object.keys(errors).length
    ? { errors }
    : { value: { name, symbol, decimals, initialSupply }, errors };
}

export function formatUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const padded = value.toString().padStart(decimals + 1, "0");
  const result = `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
  return result.replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "");
}
