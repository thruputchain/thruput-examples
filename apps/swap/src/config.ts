import { addressFromHex, toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import {
  loadDiscoveryConfig,
  type DiscoveryConfig,
} from "./token-discovery/config.ts";

const NETWORK_ID_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;

export interface GlobalConfig {
  rpcUrl: URL;
  registryEnabled?: boolean;
  tokenDiscovery?: DiscoveryConfig;
  networkIdHex: string;
  accountAddress: ContractAddress;
  routerAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeHogAddress: ContractAddress;
  knownTokenAddresses?: readonly ContractAddress[];
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
    rpcUrl: parseRpcUrl(required(environment, "VITE_GROUNDHOG_RPC_URL")),
    registryEnabled: enabled(environment, "VITE_POOL_REGISTRY_ENABLED"),
    tokenDiscovery: loadDiscoveryConfig(environment),
    networkIdHex: networkIdHex.replace(/^0x/, "").toLowerCase(),
    accountAddress: address(environment, "VITE_GROUNDHOG_WALLET_ADDRESS"),
    routerAddress: address(environment, "VITE_SWAP_ROUTER_ADDRESS"),
    factoryAddress: address(environment, "VITE_SWAP_FACTORY_ADDRESS"),
    nativeHogAddress: address(environment, "VITE_NATIVE_HOG_ADDRESS"),
    knownTokenAddresses: optionalAddresses(
      environment,
      "VITE_KNOWN_TOKEN_ADDRESSES",
    ),
  };
}

function enabled(environment: Environment, key: string): boolean {
  const value = environment[key];
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new ConfigurationError(`${key} must be true or false`);
}

export function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
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

function optionalAddresses(
  environment: Environment,
  key: string,
): ContractAddress[] {
  const value = environment[key];
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") {
    throw new ConfigurationError(`${key} must be a comma-separated address list`);
  }
  const addresses = value.split(",").map((entry) => {
    try {
      return addressFromHex(entry.trim());
    } catch {
      throw new ConfigurationError(
        `${key} must contain only 32-byte 0x-prefixed addresses`,
      );
    }
  });
  return [...new Map(addresses.map((item) => [toHex0x(item), item])).values()];
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
