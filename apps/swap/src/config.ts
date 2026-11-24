import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { ConfigurationError } from "./lib/errors";
import { parseExplorerUrl } from "./lib/explorer-url";

/** Public settings from the server's `/api/config`. */
export interface AppConfig {
  explorerUrl?: string | undefined;
  rpcUrl: URL;
  networkId: string;
  /** Hash of the LP token code that pool creation deploys. */
  poolTokenHash: string;
  routerAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeTokenAddress: ContractAddress;
}

export type Environment = Record<string, string | boolean | undefined>;

export async function loadRuntimeConfig(): Promise<AppConfig> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/config`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Application configuration is unavailable. Try again.");
  const value = (await response.json()) as Environment;
  return loadConfig({
    ...value,
    VITE_THRUPUT_RPC_URL: new URL(
      `${import.meta.env.BASE_URL}thruput-rpc`,
      window.location.origin,
    ).href,
  });
}

export function loadConfig(environment: Environment): AppConfig {
  return {
    explorerUrl: parseExplorerUrl(environment.VITE_EXPLORER_URL),
    rpcUrl: new URL(required(environment, "VITE_THRUPUT_RPC_URL")),
    networkId: hash(environment, "VITE_THRUPUT_NETWORK_ID"),
    poolTokenHash: hash(environment, "VITE_POOL_TOKEN_HASH"),
    routerAddress: address(environment, "VITE_SWAP_ROUTER_ADDRESS"),
    factoryAddress: address(environment, "VITE_SWAP_FACTORY_ADDRESS"),
    nativeTokenAddress: address(environment, "VITE_NATIVE_TOKEN_ADDRESS"),
  };
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0)
    throw new ConfigurationError(`${key} is required`);
  return value;
}

function address(environment: Environment, key: string): ContractAddress {
  const value = required(environment, key);
  try {
    return addressFromBase58(value);
  } catch {
    throw new ConfigurationError(`${key} must be a base58 contract address`);
  }
}

function hash(environment: Environment, key: string): string {
  const value = required(environment, key);
  try {
    return toBase58(hashFromBase58(value));
  } catch {
    throw new ConfigurationError(`${key} must be a base58 32-byte hash`);
  }
}
