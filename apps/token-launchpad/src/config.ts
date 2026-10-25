import {
  addressFromBase58,
  addressFromHex,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";

import { PINNED_NATIVE_BALANCE_ITEM_COST } from "./thruput/storage-cost";
import { loadSwapAppUrl } from "./launch/swap-config.ts";
import { parseExplorerUrl } from "./lib/explorer-url.ts";

export interface AppConfig {
  rpcUrl: URL;
  swapAppUrl?: string | null;
  explorerUrl?: string | null;
  networkId: string;
  accountAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeTokenAddress: ContractAddress;
  nativeBalanceItemCost: bigint;
  expectedTokenHash: Uint8Array;
}

export type Environment = Record<string, string | boolean | undefined>;

export async function loadRuntimeConfig(): Promise<AppConfig> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/config`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Application configuration is unavailable. Try again.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid application configuration");
  return loadConfig({
    ...value,
    VITE_THRUPUT_RPC_URL: new URL(
      `${import.meta.env.BASE_URL}thruput-rpc`,
      window.location.origin,
    ).href,
  });
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(environment: Environment): AppConfig {
  const network = hash(environment, "VITE_THRUPUT_NETWORK_ID");
  const tokenHash = hash(environment, "VITE_STANDARD_TOKEN_HASH");
  const rpcUrl = new URL(required(environment, "VITE_THRUPUT_RPC_URL"));
  if (
    !["http:", "https:"].includes(rpcUrl.protocol) ||
    rpcUrl.username ||
    rpcUrl.password
  ) {
    throw new ConfigurationError(
      "VITE_THRUPUT_RPC_URL must be an HTTP URL without credentials",
    );
  }
  const nativeBalanceItemCost = unsigned(
    required(environment, "VITE_NATIVE_BALANCE_ITEM_COST"),
    "VITE_NATIVE_BALANCE_ITEM_COST",
  );
  if (nativeBalanceItemCost !== PINNED_NATIVE_BALANCE_ITEM_COST) {
    throw new ConfigurationError(
      `VITE_NATIVE_BALANCE_ITEM_COST must be ${PINNED_NATIVE_BALANCE_ITEM_COST} for the pinned runtime`,
    );
  }
  return {
    rpcUrl,
    swapAppUrl: loadSwapAppUrl(environment.VITE_SWAP_APP_URL),
    explorerUrl: parseExplorerUrl(environment.VITE_EXPLORER_URL),
    networkId: network,
    // Public views need a caller, not a connected wallet identity.
    accountAddress: addressFromHex(`0x${"00".repeat(32)}`),
    factoryAddress: address(environment, "VITE_STANDARD_TOKEN_FACTORY_ADDRESS"),
    nativeTokenAddress: address(environment, "VITE_NATIVE_TOKEN_ADDRESS"),
    nativeBalanceItemCost,
    expectedTokenHash: hashFromBase58(tokenHash),
  };
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value === "")
    throw new ConfigurationError(`${key} is required`);
  return value;
}

function address(environment: Environment, key: string): ContractAddress {
  try {
    return addressFromBase58(required(environment, key));
  } catch {
    throw new ConfigurationError(`${key} must be a 32-byte base58 address`);
  }
}

// Kept as the exact text the chain reports, so string comparisons hold.
function hash(environment: Environment, key: string): string {
  const value = required(environment, key);
  try {
    if (toBase58(hashFromBase58(value)) === value) return value;
  } catch {
    // Reported below.
  }
  throw new ConfigurationError(`${key} must be a 32-byte base58 hash`);
}

function unsigned(value: string, key: string): bigint {
  if (!/^\d+$/.test(value))
    throw new ConfigurationError(`${key} must be an unsigned integer`);
  return BigInt(value);
}
