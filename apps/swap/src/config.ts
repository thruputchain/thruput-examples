import {
  addressFromBase58,
  hashFromBase58,
  toBase58,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { ConfigurationError } from "./lib/errors";
import { parseExplorerUrl } from "./lib/explorer-url";

import {
  loadDiscoveryConfig,
  type DiscoveryConfig,
} from "./token-discovery/config.ts";

// Public views require a caller, not a connected wallet or signing identity.
export const READ_ONLY_CALLER = addressFromBase58(toBase58(new Uint8Array(32)));

export interface GlobalConfig {
  explorerUrl?: string | undefined;
  rpcUrl: URL;
  tokenDiscovery?: DiscoveryConfig;
  networkId: string;
  poolTokenHash?: string;
  accountAddress: ContractAddress;
  routerAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeTokenAddress: ContractAddress;
}

export interface AppConfig extends GlobalConfig {
  liquidityTokenAddress: ContractAddress;
  handlerAddress: ContractAddress;
  driverAddress: ContractAddress;
  tokenAAddress: ContractAddress;
  tokenBAddress: ContractAddress;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenADecimals: number;
  tokenBDecimals: number;
}

export type Environment = Record<string, string | boolean | undefined>;

export async function loadRuntimeConfig(): Promise<GlobalConfig> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/config`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Application configuration is unavailable. Try again.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid application configuration");
  return loadGlobalConfig({
    ...value,
    VITE_THRUPUT_RPC_URL: new URL(
      `${import.meta.env.BASE_URL}thruput-rpc`,
      window.location.origin,
    ).href,
  });
}

export function loadGlobalConfig(environment: Environment): GlobalConfig {
  // Identifiers are canonical base58 throughout the app.
  return {
    explorerUrl: parseExplorerUrl(environment.VITE_EXPLORER_URL),
    rpcUrl: parseRpcUrl(required(environment, "VITE_THRUPUT_RPC_URL")),
    tokenDiscovery: loadDiscoveryConfig(environment),
    networkId: toBase58(hash(environment, "VITE_THRUPUT_NETWORK_ID")),
    accountAddress: READ_ONLY_CALLER,
    ...(environment.VITE_POOL_TOKEN_HASH === undefined
      ? {}
      : {
          poolTokenHash: toBase58(hash(environment, "VITE_POOL_TOKEN_HASH")),
        }),
    routerAddress: address(environment, "VITE_SWAP_ROUTER_ADDRESS"),
    factoryAddress: address(environment, "VITE_SWAP_FACTORY_ADDRESS"),
    nativeTokenAddress: address(environment, "VITE_NATIVE_TOKEN_ADDRESS"),
  };
}

export function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${key} is required`);
  }
  return value;
}

function address(environment: Environment, key: string): ContractAddress {
  const value = required(environment, key);
  try {
    const parsed = addressFromBase58(value);
    if (toBase58(parsed) === value) return parsed;
  } catch {
    // Reported below.
  }
  throw new ConfigurationError(`${key} must be a base58 contract address`);
}

function hash(environment: Environment, key: string): Uint8Array {
  const value = required(environment, key);
  try {
    const parsed = hashFromBase58(value);
    if (toBase58(parsed) === value) return parsed;
  } catch {
    // Reported below.
  }
  throw new ConfigurationError(`${key} must be a base58 32-byte hash`);
}

function parseRpcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("VITE_THRUPUT_RPC_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError("VITE_THRUPUT_RPC_URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(
      "VITE_THRUPUT_RPC_URL must not contain credentials",
    );
  }
  return url;
}
