import { normalizeNetworkId } from "./config-values";

const HEX32_PATTERN = /^0x[0-9a-f]{64}$/;

export interface AppConfig {
  readonly rpcUrl: URL;
  readonly rpcProxyPath: "/groundhog-rpc";
  readonly networkId: string;
  readonly contractAddress: string;
  readonly indexerUrl: URL;
  readonly indexerProxyPath: "/groundhog-indexer/";
  readonly transactionProfiles: LifeTransactionProfiles | null;
}

export interface TransactionPolicy {
  readonly transactionGasLimit: bigint;
  readonly targetGasLimit: bigint;
  readonly expiryBlocks: bigint;
  readonly observationTimeoutMs: number;
}

export interface LifeTransactionProfiles {
  readonly request: TransactionPolicy;
  readonly crank: TransactionPolicy;
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
    transactionProfiles: transactionProfiles(environment),
  });
}

const PROFILE_KEYS = {
  request: {
    transactionGasLimit: "VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT",
    targetGasLimit: "VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT",
    expiryBlocks: "VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS",
    observationTimeoutMs: "VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS",
  },
  crank: {
    transactionGasLimit: "VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT",
    targetGasLimit: "VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT",
    expiryBlocks: "VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS",
    observationTimeoutMs: "VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS",
  },
} as const;

function transactionProfiles(
  environment: Environment,
): LifeTransactionProfiles | null {
  const keys = Object.values(PROFILE_KEYS).flatMap((profile) =>
    Object.values(profile),
  );
  if (keys.every((key) => environment[key] === undefined)) return null;
  if (keys.some((key) => environment[key] === undefined))
    throw new ConfigurationError(
      "All Game of Life transaction profile values are required together",
    );
  const request = transactionPolicy(environment, PROFILE_KEYS.request);
  const crank = transactionPolicy(environment, PROFILE_KEYS.crank);
  if (crank.targetGasLimit < 1_000_000_000n)
    throw new ConfigurationError(
      "The crank target gas limit is an unsafe placeholder value",
    );
  return Object.freeze({ request, crank });
}

function transactionPolicy(
  environment: Environment,
  keys: (typeof PROFILE_KEYS)[keyof typeof PROFILE_KEYS],
): TransactionPolicy {
  const transactionGasLimit = decimalBigInt(
    environment,
    keys.transactionGasLimit,
  );
  const targetGasLimit = decimalBigInt(environment, keys.targetGasLimit);
  const expiryBlocks = decimalBigInt(environment, keys.expiryBlocks);
  const observationTimeoutMs = Number(
    decimalBigInt(environment, keys.observationTimeoutMs),
  );
  if (targetGasLimit > transactionGasLimit)
    throw new ConfigurationError(
      `${keys.targetGasLimit} must not exceed ${keys.transactionGasLimit}`,
    );
  if (expiryBlocks > 1_000n)
    throw new ConfigurationError(`${keys.expiryBlocks} must not exceed 1000`);
  if (
    !Number.isSafeInteger(observationTimeoutMs) ||
    observationTimeoutMs < 1_000 ||
    observationTimeoutMs > 600_000
  )
    throw new ConfigurationError(
      `${keys.observationTimeoutMs} must be between 1000 and 600000`,
    );
  return Object.freeze({
    transactionGasLimit,
    targetGasLimit,
    expiryBlocks,
    observationTimeoutMs,
  });
}

function decimalBigInt(environment: Environment, key: string): bigint {
  const value = required(environment, key);
  if (!/^[1-9][0-9]*$/.test(value))
    throw new ConfigurationError(`${key} must be a positive decimal integer`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn)
    throw new ConfigurationError(`${key} exceeds the supported u64 range`);
  return parsed;
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
