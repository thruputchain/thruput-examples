import { normalizeNetworkId } from "./config-values";

const HEX32_PATTERN = /^0x[0-9a-f]{64}$/;

export interface AppConfig {
  readonly rpcUrl: URL;
  readonly rpcProxyPath: "/groundhog-rpc";
  readonly networkId: string;
  readonly contractAddress: string;
  readonly indexerUrl: URL;
  readonly indexerProxyPath: "/groundhog-indexer/";
}

export type Environment = Readonly<
  Record<string, string | boolean | undefined>
>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadAppConfig(environment: Environment): Readonly<AppConfig> {
  const networkInput = required(environment, "VITE_GROUNDHOG_NETWORK_ID");
  let networkId: string;
  try {
    networkId = normalizeNetworkId(networkInput);
  } catch (cause) {
    throw new ConfigurationError(
      cause instanceof Error ? cause.message : "Invalid network ID",
    );
  }
  const contractAddress = required(
    environment,
    "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS",
  );
  if (!HEX32_PATTERN.test(contractAddress)) {
    throw new ConfigurationError(
      "VITE_GAME_OF_LIFE_CONTRACT_ADDRESS must be canonical lowercase 0x-prefixed hexadecimal",
    );
  }

  return Object.freeze({
    rpcUrl: httpUrl(
      required(environment, "VITE_GROUNDHOG_RPC_URL"),
      "VITE_GROUNDHOG_RPC_URL",
    ),
    rpcProxyPath: "/groundhog-rpc",
    networkId,
    contractAddress,
    indexerUrl: rootHttpUrl(
      required(environment, "VITE_GAME_OF_LIFE_INDEXER_URL"),
      "VITE_GAME_OF_LIFE_INDEXER_URL",
    ),
    indexerProxyPath: "/groundhog-indexer/",
  });
}

function rootHttpUrl(value: string, key: string): URL {
  const url = httpUrl(value, key);
  if (url.pathname !== "/" || url.search || url.hash)
    throw new ConfigurationError(
      `${key} must use the origin root without a path, query, or hash`,
    );
  return url;
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

function httpUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${key} must be a valid URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConfigurationError(
      `${key} must be an HTTP(S) URL without credentials`,
    );
  }
  return url;
}
