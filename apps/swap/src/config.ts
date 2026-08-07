import { addressFromHex } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

const NETWORK_ID_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;

export interface AppConfig {
  rpcUrl: URL;
  networkId: bigint;
  networkIdHex: string;
  accountAddress: ContractAddress;
  routerAddress: ContractAddress;
  pairAddress: ContractAddress;
  handlerAddress: ContractAddress;
  driverAddress: ContractAddress;
  tokenAAddress: ContractAddress;
  tokenBAddress: ContractAddress;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenDecimals: number;
}

export type Environment = Record<string, string | boolean | undefined>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadAppConfig(environment: Environment): AppConfig {
  const networkIdHex = required(environment, "VITE_GROUNDHOG_NETWORK_ID");
  if (!NETWORK_ID_PATTERN.test(networkIdHex)) {
    throw new ConfigurationError(
      "VITE_GROUNDHOG_NETWORK_ID must be a 32-byte hexadecimal value",
    );
  }

  const tokenAAddress = address(environment, "VITE_TOKEN_A_ADDRESS");
  const tokenBAddress = address(environment, "VITE_TOKEN_B_ADDRESS");
  if (tokenAAddress.every((byte, index) => byte === tokenBAddress[index])) {
    throw new ConfigurationError("Token A and token B addresses must differ");
  }

  return {
    rpcUrl: parseRpcUrl(required(environment, "VITE_GROUNDHOG_RPC_URL")),
    networkId: BigInt(
      networkIdHex.startsWith("0x") ? networkIdHex : `0x${networkIdHex}`,
    ),
    networkIdHex: networkIdHex.replace(/^0x/, "").toLowerCase(),
    accountAddress: address(environment, "VITE_GROUNDHOG_WALLET_ADDRESS"),
    routerAddress: address(environment, "VITE_SWAP_ROUTER_ADDRESS"),
    pairAddress: address(environment, "VITE_SWAP_PAIR_ADDRESS"),
    handlerAddress: address(environment, "VITE_SWAP_HANDLER_ADDRESS"),
    driverAddress: address(environment, "VITE_SWAP_DRIVER_ADDRESS"),
    tokenAAddress,
    tokenBAddress,
    tokenASymbol: optional(environment, "VITE_TOKEN_A_SYMBOL", "Token A"),
    tokenBSymbol: optional(environment, "VITE_TOKEN_B_SYMBOL", "Token B"),
    tokenDecimals: parseDecimals(
      optional(environment, "VITE_TOKEN_DECIMALS", "6"),
    ),
  };
}

export function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
}

export function isBrowserLoopback(): boolean {
  return typeof window === "undefined" || isLoopbackHostname(window.location.hostname);
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

function optional(
  environment: Environment,
  key: string,
  fallback: string,
): string {
  const value = environment[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
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
  return url;
}

function parseDecimals(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError("VITE_TOKEN_DECIMALS must be an integer");
  }
  const decimals = Number(value);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ConfigurationError(
      "VITE_TOKEN_DECIMALS must be between 0 and 255",
    );
  }
  return decimals;
}
