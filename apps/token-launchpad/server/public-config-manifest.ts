import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../src/runtime.ts";
import { loadSwapAppUrl } from "../src/swap-config.ts";
import { loadExplorerUrl } from "../src/explorer-config.ts";
import {
  canonicalAddress,
  canonicalDecimal,
  canonicalNetworkId,
} from "./validation.ts";

export const PUBLIC_CONFIG_MANIFEST_FILENAME = "groundhog-public-config.json";

export const PUBLIC_CONFIG_KEYS = [
  "VITE_GROUNDHOG_RPC_URL_SHA256",
  "VITE_GROUNDHOG_NETWORK_ID",
  "VITE_GROUNDHOG_WALLET_ADDRESS",
  "VITE_GROUNDHOG_WALLET_ENTRYPOINT",
  "VITE_NATIVE_HOG_ADDRESS",
  "VITE_NATIVE_BALANCE_ITEM_COST",
  "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
  "VITE_STANDARD_TOKEN_HASH",
  "VITE_TOKEN_REGISTRY_ENABLED",
  "VITE_SWAP_APP_URL",
  "VITE_EXPLORER_URL",
] as const;

type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];
export type PublicConfigManifest = Record<PublicConfigKey, string>;
export type PublicConfigEnvironment = Record<string, string | undefined>;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ENTRYPOINT = /^0x[0-9a-fA-F]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class PublicConfigManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicConfigManifestError";
  }
}

export function createPublicConfigManifest(
  environment: PublicConfigEnvironment,
): PublicConfigManifest {
  const rpcUrl = required(environment, "VITE_GROUNDHOG_RPC_URL");
  validateRpcUrl(rpcUrl);
  const manifest = {
    VITE_SWAP_APP_URL: loadSwapAppUrl(environment.VITE_SWAP_APP_URL) ?? "",
    VITE_EXPLORER_URL: loadExplorerUrl(environment.VITE_EXPLORER_URL) ?? "",
    VITE_GROUNDHOG_RPC_URL_SHA256: digestRpcUrl(rpcUrl),
    VITE_GROUNDHOG_NETWORK_ID: required(
      environment,
      "VITE_GROUNDHOG_NETWORK_ID",
    ),
    VITE_GROUNDHOG_WALLET_ADDRESS: required(
      environment,
      "VITE_GROUNDHOG_WALLET_ADDRESS",
    ),
    VITE_GROUNDHOG_WALLET_ENTRYPOINT: required(
      environment,
      "VITE_GROUNDHOG_WALLET_ENTRYPOINT",
    ),
    VITE_NATIVE_HOG_ADDRESS: required(environment, "VITE_NATIVE_HOG_ADDRESS"),
    VITE_NATIVE_BALANCE_ITEM_COST: required(
      environment,
      "VITE_NATIVE_BALANCE_ITEM_COST",
    ),
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: required(
      environment,
      "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
    ),
    VITE_STANDARD_TOKEN_HASH: required(environment, "VITE_STANDARD_TOKEN_HASH"),
    VITE_TOKEN_REGISTRY_ENABLED: required(
      environment,
      "VITE_TOKEN_REGISTRY_ENABLED",
    ),
  } satisfies PublicConfigManifest;
  validateManifestFields(manifest);
  return manifest;
}

export function parsePublicConfigManifest(
  contents: string,
): PublicConfigManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new PublicConfigManifestError(
      "Production public configuration manifest is not valid JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicConfigManifestError(
      "Production public configuration manifest has an invalid shape",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== PUBLIC_CONFIG_KEYS.length ||
    keys.some((key) => !PUBLIC_CONFIG_KEYS.includes(key as PublicConfigKey))
  ) {
    throw new PublicConfigManifestError(
      "Production public configuration manifest has unexpected fields",
    );
  }
  const manifest = value as PublicConfigManifest;
  validateManifestFields(manifest);
  return manifest;
}

export async function verifyPublicConfigManifest(
  manifestPath: string,
  environment: PublicConfigEnvironment,
): Promise<PublicConfigManifest> {
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch {
    throw new PublicConfigManifestError(
      "Production public configuration manifest is missing or unreadable",
    );
  }
  const manifest = parsePublicConfigManifest(contents);
  const runtime = createPublicConfigManifest(environment);
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (manifest[key] !== runtime[key]) {
      const environmentKey =
        key === "VITE_GROUNDHOG_RPC_URL_SHA256"
          ? "VITE_GROUNDHOG_RPC_URL"
          : key;
      throw new PublicConfigManifestError(
        `${environmentKey} does not match the production build manifest`,
      );
    }
  }
  return manifest;
}

function required(environment: PublicConfigEnvironment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublicConfigManifestError(`${key} is required`);
  }
  return value;
}

function digestRpcUrl(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_RPC_URL must be a valid URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_RPC_URL must use HTTP or HTTPS",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_RPC_URL must not contain credentials",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_RPC_URL must not contain a query string or fragment",
    );
  }
}

function validateManifestFields(manifest: PublicConfigManifest): void {
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (
      typeof manifest[key] !== "string" ||
      (manifest[key] === "" &&
        key !== "VITE_SWAP_APP_URL" &&
        key !== "VITE_EXPLORER_URL")
    ) {
      throw new PublicConfigManifestError(`${key} must be a nonempty string`);
    }
  }
  validate(
    manifest.VITE_EXPLORER_URL ===
      (loadExplorerUrl(manifest.VITE_EXPLORER_URL) ?? ""),
    "VITE_EXPLORER_URL must be canonical",
  );
  validate(
    manifest.VITE_SWAP_APP_URL ===
      (loadSwapAppUrl(manifest.VITE_SWAP_APP_URL) ?? ""),
    "VITE_SWAP_APP_URL must be canonical",
  );
  validate(
    SHA256.test(manifest.VITE_GROUNDHOG_RPC_URL_SHA256),
    "VITE_GROUNDHOG_RPC_URL_SHA256 must be a SHA-256 digest",
  );
  validateWithHelper(() =>
    canonicalNetworkId(
      manifest.VITE_GROUNDHOG_NETWORK_ID,
      "VITE_GROUNDHOG_NETWORK_ID",
    ),
  );
  for (const key of [
    "VITE_GROUNDHOG_WALLET_ADDRESS",
    "VITE_NATIVE_HOG_ADDRESS",
    "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
  ] as const) {
    validateWithHelper(() => canonicalAddress(manifest[key], key));
  }
  validate(
    ENTRYPOINT.test(manifest.VITE_GROUNDHOG_WALLET_ENTRYPOINT),
    "VITE_GROUNDHOG_WALLET_ENTRYPOINT must be an 8-byte 0x-prefixed hexadecimal value",
  );
  validateWithHelper(() =>
    canonicalDecimal(
      manifest.VITE_NATIVE_BALANCE_ITEM_COST,
      "VITE_NATIVE_BALANCE_ITEM_COST",
    ),
  );
  validate(
    BigInt(manifest.VITE_NATIVE_BALANCE_ITEM_COST) ===
      PINNED_NATIVE_BALANCE_ITEM_COST,
    "VITE_NATIVE_BALANCE_ITEM_COST must match the pinned runtime",
  );
  validate(
    HASH.test(manifest.VITE_STANDARD_TOKEN_HASH),
    "VITE_STANDARD_TOKEN_HASH must be a 32-byte 0x-prefixed hexadecimal value",
  );
  validate(
    manifest.VITE_TOKEN_REGISTRY_ENABLED === "true",
    "VITE_TOKEN_REGISTRY_ENABLED must be exactly true",
  );
}

function validate(condition: boolean, message: string): void {
  if (!condition) throw new PublicConfigManifestError(message);
}

function validateWithHelper(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    throw new PublicConfigManifestError(
      error instanceof Error ? error.message : "Invalid public configuration",
    );
  }
}
