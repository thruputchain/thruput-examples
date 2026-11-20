import { parseConfig } from "../src/config";

export function parseRpcUrl(value: string) {
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

export function loadConfig(env: Record<string, string | undefined>) {
  const rpcUrl = parseRpcUrl(env.THRUPUT_RPC_URL || "http://127.0.0.1:9545");
  parseConfig(env);
  return {
    rpcUrl,
    publicConfig: {
      VITE_THRUPUT_NETWORK_ID: env.VITE_THRUPUT_NETWORK_ID,
      VITE_VOTING_ADDRESS: env.VITE_VOTING_ADDRESS,
    },
  };
}

export type ServerConfig = ReturnType<typeof loadConfig>;
