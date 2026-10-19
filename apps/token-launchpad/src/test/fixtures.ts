import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";

export class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

export function configuration(): AppConfig {
  return {
    rpcUrl: new URL("http://127.0.0.1:9545"),
    networkId: toBase58(new Uint8Array(32).fill(1)),
    accountAddress: contractAddress(new Uint8Array(32).fill(2)),
    factoryAddress: contractAddress(new Uint8Array(32).fill(3)),
    nativeHogAddress: contractAddress(new Uint8Array(32)),
    nativeBalanceItemCost: 10n,
    expectedTokenHash: new Uint8Array(32),
  };
}
