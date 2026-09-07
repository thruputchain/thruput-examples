export function tokenAddress(value: string): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value)
    ? value.toLowerCase()
    : null;
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
