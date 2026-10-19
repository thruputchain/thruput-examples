import { addressFromBase58, toBase58, toHex0x } from "@thruputchain/client";

/** Accept a base58 address (or a legacy 0x hex one) as the app's 0x hex form. */
export function tokenAddress(value: string): string | null {
  let hex: string | null = null;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    hex = value.toLowerCase();
  } else {
    try {
      const address = addressFromBase58(value);
      if (toBase58(address) === value) hex = toHex0x(address);
    } catch {
      hex = null;
    }
  }
  return hex !== null && !/^0x0{64}$/.test(hex) ? hex : null;
}

export function readCreationPresets(search: string) {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const read = (key: "tokenA" | "tokenB") => {
    const values = params.getAll(key);
    if (values.length === 0) return "";
    const address = values.length === 1 ? tokenAddress(values[0]!) : null;
    if (address !== null) return address;
    warnings.push(
      `${key} preset was ignored: provide one nonzero 32-byte contract address.`,
    );
    return "";
  };
  const tokenA = read("tokenA");
  let tokenB = read("tokenB");
  if (tokenA && tokenA === tokenB) {
    tokenB = "";
    warnings.push(
      "tokenB preset was ignored: choose a different contract from tokenA.",
    );
  }
  return { tokenA, tokenB, warnings };
}
