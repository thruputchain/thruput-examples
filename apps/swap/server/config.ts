import path from "node:path";
import { loadTokenDiscoveryServerConfig } from "./token-discovery-config.ts";

import type { RegistryScope } from "../shared/registry.ts";
import {
  boundedInteger,
  canonicalAddress,
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
  tokenDiscovery: ReturnType<typeof loadTokenDiscoveryServerConfig>;
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
    const databasePath = required(environment, "POOL_REGISTRY_DB_PATH");
    if (
      databasePath.includes("\0") ||
      databasePath === ":memory:" ||
      path.basename(databasePath) === "" ||
      databasePath.endsWith(path.sep)
    ) {
      throw new ValidationError("POOL_REGISTRY_DB_PATH must be a file path");
    }

    return {
      tokenDiscovery: loadTokenDiscoveryServerConfig(environment),
      port: boundedInteger(required(environment, "PORT"), "PORT", 1, 65_535),
      databasePath,
      rpcUrl: parseRpcUrl(required(environment, "VITE_GROUNDHOG_RPC_URL")),
      scope: {
        networkId: canonicalNetworkId(
          required(environment, "VITE_GROUNDHOG_NETWORK_ID"),
          "VITE_GROUNDHOG_NETWORK_ID",
        ),
        factoryAddress: canonicalAddress(
          required(environment, "VITE_SWAP_FACTORY_ADDRESS"),
          "VITE_SWAP_FACTORY_ADDRESS",
        ),
      },
      syncIntervalMs: optionalInteger(
        environment,
        "POOL_REGISTRY_SYNC_INTERVAL_MS",
        5_000,
        1_000,
        86_400_000,
      ),
      pageSize: optionalInteger(
        environment,
        "POOL_REGISTRY_PAGE_SIZE",
        200,
        1,
        500,
      ),
    };
  } catch (error) {
    if (error instanceof ServerConfigurationError) throw error;
    throw new ServerConfigurationError(
      error instanceof Error ? error.message : "Invalid server configuration",
    );
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

function parseRpcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("VITE_GROUNDHOG_RPC_URL must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ValidationError(
      "VITE_GROUNDHOG_RPC_URL must be an HTTP URL without credentials, a query string, or a fragment",
    );
  }
  return url;
}
