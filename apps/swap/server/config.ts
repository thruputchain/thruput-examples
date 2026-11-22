import { loadConfig } from "../src/config.ts";

/** Only these public values cross the server/browser boundary. */
const PUBLIC_KEYS = [
  "VITE_EXPLORER_URL",
  "VITE_THRUPUT_NETWORK_ID",
  "VITE_NATIVE_TOKEN_ADDRESS",
  "VITE_POOL_TOKEN_HASH",
  "VITE_SWAP_FACTORY_ADDRESS",
  "VITE_SWAP_ROUTER_ADDRESS",
] as const;

export interface ServerConfig {
  rpcUrl: string;
  publicConfig: Record<string, string>;
}

export function parseRpcUrl(value: string): string {
  const rpcUrl = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    rpcUrl.hostname,
  );
  if (
    (rpcUrl.protocol !== "https:" &&
      !(rpcUrl.protocol === "http:" && loopback)) ||
    rpcUrl.username ||
    rpcUrl.password ||
    rpcUrl.search ||
    rpcUrl.hash
  )
    throw new Error("Use HTTPS for devnet or loopback HTTP for a local node.");
  return rpcUrl.href;
}

export function loadServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const rpcUrl = parseRpcUrl(
    env.VITE_THRUPUT_RPC_URL || env.THRUPUT_RPC_URL || "http://127.0.0.1:9545",
  );
  // Check the values the browser will parse, so a bad environment fails at
  // startup rather than in the browser.
  loadConfig({ ...env, VITE_THRUPUT_RPC_URL: rpcUrl });
  return {
    rpcUrl,
    publicConfig: Object.fromEntries(
      PUBLIC_KEYS.flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]!]],
      ),
    ),
  };
}
