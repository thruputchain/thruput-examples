import { loadGlobalConfig } from "../src/config.ts";

/** Upstream URLs and server settings are deliberately absent. */
const KEYS = [
  "VITE_GROUNDHOG_NETWORK_ID",
  "VITE_NATIVE_HOG_ADDRESS",
  "VITE_POOL_TOKEN_HASH",
  "VITE_SWAP_FACTORY_ADDRESS",
  "VITE_SWAP_ROUTER_ADDRESS",
  "VITE_EXPLORER_URL",
  "VITE_TOKEN_DISCOVERY_ENABLED",
  "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
  "VITE_STANDARD_TOKEN_HASH",
] as const;

export function publicConfig(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  loadGlobalConfig(environment);
  return Object.fromEntries(
    KEYS.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]!]],
    ),
  );
}
