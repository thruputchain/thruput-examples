import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import {
  loadDiscoveryConfig,
  type DiscoveryConfig,
} from "./token-discovery/config.ts";

const NETWORK_ID_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;

// Public views require a caller, not a connected wallet or signing identity.
export const READ_ONLY_CALLER = addressFromHex(`0x${"00".repeat(32)}`);

export interface GlobalConfig {
  explorerUrl?: string | undefined;
  rpcUrl: URL;
  tokenDiscovery?: DiscoveryConfig;
  networkIdHex: string;
  poolTokenHash?: string;
  accountAddress: ContractAddress;
  routerAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeHogAddress: ContractAddress;
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
  const response = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Application configuration is unavailable. Try again.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid application configuration");
  return loadGlobalConfig({ ...value, VITE_GROUNDHOG_RPC_URL: new URL("/groundhog-rpc", window.location.origin).href });
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadGlobalConfig(environment: Environment): GlobalConfig {
  const networkIdHex = required(environment, "VITE_GROUNDHOG_NETWORK_ID");
  if (!NETWORK_ID_PATTERN.test(networkIdHex)) {
    throw new ConfigurationError(
      "VITE_GROUNDHOG_NETWORK_ID must be a 32-byte hexadecimal value",
    );
  }

  return {
    explorerUrl: parseExplorerUrl(environment.VITE_EXPLORER_URL),
    rpcUrl: parseRpcUrl(required(environment, "VITE_GROUNDHOG_RPC_URL")),
    tokenDiscovery: loadDiscoveryConfig(environment),
    networkIdHex: networkIdHex.replace(/^0x/, "").toLowerCase(),
    accountAddress: READ_ONLY_CALLER,
    ...(environment.VITE_POOL_TOKEN_HASH === undefined ? {} : {
      poolTokenHash: toHex0x(address(environment, "VITE_POOL_TOKEN_HASH")),
    }),
    routerAddress: address(environment, "VITE_SWAP_ROUTER_ADDRESS"),
    factoryAddress: address(environment, "VITE_SWAP_FACTORY_ADDRESS"),
    nativeHogAddress: address(environment, "VITE_NATIVE_HOG_ADDRESS"),
  };
}

export function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
}

export function parseExplorerUrl(
  value: string | boolean | undefined,
): string | undefined {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    return undefined;
  }
  const message =
    "VITE_EXPLORER_URL must be a root HTTPS URL (HTTP is allowed only on exact loopback hosts), without credentials, a query, or a fragment";
  if (typeof value !== "string") throw new ConfigurationError(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(message);
  }
  // Check the input too: URL parsing otherwise erases dot paths and empty ?/#.
  if (
    !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(
          value,
        )
      ))
  ) {
    throw new ConfigurationError(message);
  }
  return url.origin;
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
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
    return addressFromHex(value);
  } catch {
    throw new ConfigurationError(`${key} must be a 32-byte 0x-prefixed address`);
  }
}

function parseRpcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("VITE_GROUNDHOG_RPC_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError("VITE_GROUNDHOG_RPC_URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(
      "VITE_GROUNDHOG_RPC_URL must not contain credentials",
    );
  }
  return url;
}
