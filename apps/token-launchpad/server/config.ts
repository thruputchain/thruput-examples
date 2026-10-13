import path from "node:path";

import type { RegistryScope } from "../shared/registry.ts";
import {
  boundedInteger,
  canonicalAddress,
  canonicalHash,
  canonicalNetworkId,
  ValidationError,
} from "./validation.ts";

export interface ServerConfig {
  port: number;
  databasePath: string;
  rpcUrl: URL;
  scope: RegistryScope;
  syncIntervalMs: number;
  pageSize: number;
}

export type ServerEnvironment = Record<string, string | undefined>;

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

export function loadServerConfig(environment: ServerEnvironment): ServerConfig {
  try {
    const databasePath = required(environment, "TOKEN_REGISTRY_DB_PATH");
    if (databasePath.includes("\0") || path.basename(databasePath) === "") {
      throw new ValidationError("TOKEN_REGISTRY_DB_PATH must be a file path");
    }

    const rpcUrl = parseUrl(required(environment, "VITE_THRUPUT_RPC_URL"));
    return {
      port: boundedInteger(required(environment, "PORT"), "PORT", 1, 65_535),
      databasePath,
      rpcUrl,
      scope: {
        networkId: canonicalNetworkId(
          required(environment, "VITE_THRUPUT_NETWORK_ID"),
          "VITE_THRUPUT_NETWORK_ID",
        ),
        factoryAddress: canonicalAddress(
          required(environment, "VITE_STANDARD_TOKEN_FACTORY_ADDRESS"),
          "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
        ),
        tokenCodeHash: canonicalHash(
          required(environment, "VITE_STANDARD_TOKEN_HASH"),
          "VITE_STANDARD_TOKEN_HASH",
        ),
      },
      syncIntervalMs: optionalInteger(
        environment,
        "TOKEN_REGISTRY_SYNC_INTERVAL_MS",
        5_000,
        1_000,
        86_400_000,
      ),
      pageSize: optionalInteger(
        environment,
        "TOKEN_REGISTRY_PAGE_SIZE",
        200,
        1,
        500,
      ),
    };
  } catch (error) {
    if (error instanceof ServerConfigurationError) throw error;
    const message =
      error instanceof Error ? error.message : "Invalid server configuration";
    throw new ServerConfigurationError(message);
  }
}

function required(environment: ServerEnvironment, key: string): string {
  const value = environment[key];
  if (value === undefined || value === "") {
    throw new ServerConfigurationError(`${key} is required`);
  }
  return value;
}

function optionalInteger(
  environment: ServerEnvironment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[key];
  return value === undefined
    ? fallback
    : boundedInteger(value, key, minimum, maximum);
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("VITE_THRUPUT_RPC_URL must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ValidationError(
      "VITE_THRUPUT_RPC_URL must be an HTTP URL without credentials, a query string, or a fragment",
    );
  }
  return url;
}
