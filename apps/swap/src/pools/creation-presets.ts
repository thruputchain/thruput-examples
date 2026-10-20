import { typedAddress } from "@/lib/address";
import { ZERO_ADDRESS } from "../../shared/registry";

/** Read a nonzero base58 or C StrKey address as canonical base58. */
export function tokenAddress(value: string): string | null {
  const address = typedAddress(value);
  return address !== null && address !== ZERO_ADDRESS ? address : null;
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
      `${key} preset was ignored: provide one nonzero base58 contract address.`,
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
