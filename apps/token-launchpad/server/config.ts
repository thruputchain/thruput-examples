import path from "node:path";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import { loadConfig } from "../src/config.ts";

/** Only these public values cross the server/browser boundary. */
const PUBLIC_KEYS = [
  "VITE_THRUPUT_NETWORK_ID",
  "VITE_NATIVE_TOKEN_ADDRESS",
  "VITE_NATIVE_BALANCE_ITEM_COST",
  "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
  "VITE_STANDARD_TOKEN_HASH",
  "VITE_SWAP_APP_URL",
  "VITE_EXPLORER_URL",
] as const;

export interface ServerConfig {
  rpcUrl: string;
  networkId: string;
  factoryAddress: string;
  databasePath: string;
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
  root: string,
): ServerConfig {
  const rpcUrl = parseRpcUrl(
    env.VITE_THRUPUT_RPC_URL || env.THRUPUT_RPC_URL || "http://127.0.0.1:9545",
  );
  // Check the public values the browser will parse, so a bad environment
  // fails at startup rather than in the browser.
  loadConfig({ ...env, VITE_THRUPUT_RPC_URL: rpcUrl });
  const factoryAddress = toBase58(
    addressFromBase58(env.VITE_STANDARD_TOKEN_FACTORY_ADDRESS ?? ""),
  );
  return {
    rpcUrl,
    networkId: env.VITE_THRUPUT_NETWORK_ID!,
    factoryAddress,
    // One database per factory: a new deployment starts a new index.
    databasePath:
      env.TOKEN_REGISTRY_DB_PATH ||
      path.join(root, ".local", `tokens-${factoryAddress}.sqlite`),
    publicConfig: Object.fromEntries(
      PUBLIC_KEYS.flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]!]],
      ),
    ),
  };
}
