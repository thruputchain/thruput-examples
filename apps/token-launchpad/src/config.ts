import { addressFromHex, fromHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { PINNED_NATIVE_BALANCE_ITEM_COST } from "@/runtime";

const HASH = /^(?:0x)?[0-9a-fA-F]{64}$/;

export interface AppConfig {
  rpcUrl: URL;
  registryEnabled: boolean;
  networkIdHex: string;
  accountAddress: ContractAddress;
  factoryAddress: ContractAddress;
  nativeHogAddress: ContractAddress;
  nativeBalanceItemCost: bigint;
  expectedTokenHash: Uint8Array;
}

export type Environment = Record<string, string | boolean | undefined>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(environment: Environment): AppConfig {
  const network = required(environment, "VITE_GROUNDHOG_NETWORK_ID");
  const hash = required(environment, "VITE_STANDARD_TOKEN_HASH");
  if (!HASH.test(network))
    throw new ConfigurationError(
      "VITE_GROUNDHOG_NETWORK_ID must be a 32-byte hexadecimal value",
    );
  if (!HASH.test(hash))
    throw new ConfigurationError(
      "VITE_STANDARD_TOKEN_HASH must be a 32-byte hexadecimal value",
    );
  const rpcUrl = new URL(required(environment, "VITE_GROUNDHOG_RPC_URL"));
  if (
    !["http:", "https:"].includes(rpcUrl.protocol) ||
    rpcUrl.username ||
    rpcUrl.password
  ) {
    throw new ConfigurationError(
      "VITE_GROUNDHOG_RPC_URL must be an HTTP URL without credentials",
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
    registryEnabled: enabled(environment, "VITE_TOKEN_REGISTRY_ENABLED"),
    networkIdHex: network.replace(/^0x/, "").toLowerCase(),
    accountAddress: address(environment, "VITE_GROUNDHOG_WALLET_ADDRESS"),
    factoryAddress: address(environment, "VITE_STANDARD_TOKEN_FACTORY_ADDRESS"),
    nativeHogAddress: address(environment, "VITE_NATIVE_HOG_ADDRESS"),
    nativeBalanceItemCost,
    expectedTokenHash: fromHex0x(hash.startsWith("0x") ? hash : `0x${hash}`),
  };
}

function enabled(environment: Environment, key: string): boolean {
  const value = environment[key];
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new ConfigurationError(`${key} must be true or false`);
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value === "")
    throw new ConfigurationError(`${key} is required`);
  return value;
}

function address(environment: Environment, key: string): ContractAddress {
  try {
    return addressFromHex(required(environment, key));
  } catch {
    throw new ConfigurationError(
      `${key} must be a 32-byte 0x-prefixed address`,
    );
  }
}

function unsigned(value: string, key: string): bigint {
  if (!/^\d+$/.test(value))
    throw new ConfigurationError(`${key} must be an unsigned integer`);
  return BigInt(value);
}
