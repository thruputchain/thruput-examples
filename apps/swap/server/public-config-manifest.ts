import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalAddress, canonicalNetworkId } from "./validation.ts";

export const PUBLIC_CONFIG_MANIFEST_FILENAME = "groundhog-public-config.json";

export const PUBLIC_CONFIG_KEYS = [
  "VITE_GROUNDHOG_RPC_URL_SHA256",
  "VITE_GROUNDHOG_NETWORK_ID",
  "VITE_GROUNDHOG_WALLET_ADDRESS",
  "VITE_GROUNDHOG_WALLET_ENTRYPOINT",
  "VITE_NATIVE_HOG_ADDRESS",
  "VITE_KNOWN_TOKEN_ADDRESSES",
  "VITE_SWAP_FACTORY_ADDRESS",
  "VITE_SWAP_ROUTER_ADDRESS",
  "VITE_POOL_REGISTRY_ENABLED",
] as const;

type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];
export type PublicConfigManifest = Record<PublicConfigKey, string>;
export type PublicConfigEnvironment = Record<string, string | undefined>;

const ENTRYPOINT = /^0x[0-9a-f]{16}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

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
    VITE_GROUNDHOG_RPC_URL_SHA256: createHash("sha256")
      .update(new URL(rpcUrl).href)
      .digest("hex"),
    VITE_GROUNDHOG_NETWORK_ID: normalizeNetwork(
      required(environment, "VITE_GROUNDHOG_NETWORK_ID"),
    ),
    VITE_GROUNDHOG_WALLET_ADDRESS: normalizeAddress(
      required(environment, "VITE_GROUNDHOG_WALLET_ADDRESS"),
      "VITE_GROUNDHOG_WALLET_ADDRESS",
    ),
    VITE_GROUNDHOG_WALLET_ENTRYPOINT: normalizeEntrypoint(
      required(environment, "VITE_GROUNDHOG_WALLET_ENTRYPOINT"),
    ),
    VITE_NATIVE_HOG_ADDRESS: normalizeAddress(
      required(environment, "VITE_NATIVE_HOG_ADDRESS"),
      "VITE_NATIVE_HOG_ADDRESS",
    ),
    VITE_KNOWN_TOKEN_ADDRESSES: normalizeKnownTokens(
      required(environment, "VITE_KNOWN_TOKEN_ADDRESSES"),
    ),
    VITE_SWAP_FACTORY_ADDRESS: normalizeAddress(
      required(environment, "VITE_SWAP_FACTORY_ADDRESS"),
      "VITE_SWAP_FACTORY_ADDRESS",
    ),
    VITE_SWAP_ROUTER_ADDRESS: normalizeAddress(
      required(environment, "VITE_SWAP_ROUTER_ADDRESS"),
      "VITE_SWAP_ROUTER_ADDRESS",
    ),
    VITE_POOL_REGISTRY_ENABLED: required(
      environment,
      "VITE_POOL_REGISTRY_ENABLED",
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
  const build = parsePublicConfigManifest(contents);
  const runtime = createPublicConfigManifest(environment);
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (build[key] !== runtime[key]) {
      throw new PublicConfigManifestError(
        `${key === "VITE_GROUNDHOG_RPC_URL_SHA256" ? "VITE_GROUNDHOG_RPC_URL" : key} does not match the production build manifest`,
      );
    }
  }
  return build;
}

function validateManifestFields(manifest: PublicConfigManifest): void {
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") {
      throw new PublicConfigManifestError(`${key} must be a nonempty string`);
    }
  }
  validate(
    SHA256.test(manifest.VITE_GROUNDHOG_RPC_URL_SHA256),
    "VITE_GROUNDHOG_RPC_URL_SHA256 must be a SHA-256 digest",
  );
  validate(
    manifest.VITE_GROUNDHOG_NETWORK_ID ===
      normalizeNetwork(manifest.VITE_GROUNDHOG_NETWORK_ID),
    "VITE_GROUNDHOG_NETWORK_ID must be canonical",
  );
  for (const key of [
    "VITE_GROUNDHOG_WALLET_ADDRESS",
    "VITE_NATIVE_HOG_ADDRESS",
    "VITE_SWAP_FACTORY_ADDRESS",
    "VITE_SWAP_ROUTER_ADDRESS",
  ] as const) {
    validate(
      manifest[key] === normalizeAddress(manifest[key], key),
      `${key} must be canonical`,
    );
  }
  validate(
    ENTRYPOINT.test(manifest.VITE_GROUNDHOG_WALLET_ENTRYPOINT),
    "VITE_GROUNDHOG_WALLET_ENTRYPOINT must be a canonical 8-byte hexadecimal value",
  );
  validate(
    manifest.VITE_KNOWN_TOKEN_ADDRESSES ===
      normalizeKnownTokens(manifest.VITE_KNOWN_TOKEN_ADDRESSES),
    "VITE_KNOWN_TOKEN_ADDRESSES must be a canonical address list",
  );
  validate(
    manifest.VITE_POOL_REGISTRY_ENABLED === "true",
    "VITE_POOL_REGISTRY_ENABLED must be exactly true",
  );
}

function required(environment: PublicConfigEnvironment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublicConfigManifestError(`${key} is required`);
  }
  return value;
}

function normalizeNetwork(value: string): string {
  try {
    return canonicalNetworkId(value, "VITE_GROUNDHOG_NETWORK_ID");
  } catch {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_NETWORK_ID must be a 32-byte hexadecimal value",
    );
  }
}

function normalizeAddress(value: string, key: string): string {
  try {
    return canonicalAddress(value.toLowerCase(), key);
  } catch {
    throw new PublicConfigManifestError(
      `${key} must be a 32-byte 0x-prefixed address`,
    );
  }
}

function normalizeEntrypoint(value: string): string {
  const normalized = value.toLowerCase();
  if (!ENTRYPOINT.test(normalized)) {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_WALLET_ENTRYPOINT must be an 8-byte 0x-prefixed hexadecimal value",
    );
  }
  return normalized;
}

function normalizeKnownTokens(value: string): string {
  const tokens = value
    .split(",")
    .map((entry) =>
      normalizeAddress(entry.trim(), "VITE_KNOWN_TOKEN_ADDRESSES"),
    );
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    throw new PublicConfigManifestError(
      "VITE_KNOWN_TOKEN_ADDRESSES must contain addresses",
    );
  }
  return [...new Set(tokens)].join(",");
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
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PublicConfigManifestError(
      "VITE_GROUNDHOG_RPC_URL must be an HTTP URL without credentials, a query string, or a fragment",
    );
  }
}

function validate(condition: boolean, message: string): void {
  if (!condition) throw new PublicConfigManifestError(message);
}
