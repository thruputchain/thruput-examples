import { loadConfig, nativeTokenKey } from "../src/config.ts";

/** Only these public values cross the server/browser boundary. */
const KEYS = [
  "VITE_THRUPUT_NETWORK_ID",
  "VITE_NATIVE_TOKEN_ADDRESS",
  "VITE_NATIVE_BALANCE_ITEM_COST",
  "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
  "VITE_STANDARD_TOKEN_HASH",
  "VITE_SWAP_APP_URL",
  "VITE_EXPLORER_URL",
] as const;

export function publicConfig(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  loadConfig(environment);
  const source: Record<string, string | undefined> = {
    ...environment,
    VITE_NATIVE_TOKEN_ADDRESS: environment[nativeTokenKey(environment)],
  };
  return Object.fromEntries(
    KEYS.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]!]],
    ),
  );
}
