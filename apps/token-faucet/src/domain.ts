export interface FaucetToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface FaucetManifest {
  version: 1;
  network: string;
  rpcUrl: string;
  account: string;
  swapUrl: string;
  explorerUrl: string;
  tokens: FaucetToken[];
}

export interface ClaimStatus {
  state: "available" | "pending" | "claimed";
  transactionHash?: string;
}

export function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("Enter a valid 32-byte wallet address.");
  }
  const address = `0x${value.replace(/^0x/, "").toLowerCase()}`;
  if (/^0x0+$/.test(address))
    throw new Error("The zero address cannot receive faucet tokens.");
  return address;
}
