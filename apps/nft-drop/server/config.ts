import { fromHex0x } from "@thruputchain/client";
import { parseConfig } from "../src/config";
import { MAX_CROWD_SIZE } from "./crowd";

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
    throw new Error("Use HTTPS, or loopback HTTP for a local node.");
  return rpcUrl.href;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const rpcUrl = parseRpcUrl(env.THRUPUT_RPC_URL || "http://127.0.0.1:9545");
  // The crowd seed is private: it derives every crowd account's key.
  const seed = env.NFT_CROWD_SEED;
  if (seed !== undefined && seed !== "" && !/^0x[0-9a-fA-F]{64}$/.test(seed))
    throw new Error("NFT_CROWD_SEED must be 32 bytes of 0x hex.");
  const crowdSeed = seed ? fromHex0x(seed) : null;
  const crowdSize = crowdSeed
    ? Number(env.NFT_CROWD_SIZE ?? MAX_CROWD_SIZE)
    : 0;
  if (
    !Number.isInteger(crowdSize) ||
    crowdSize < 0 ||
    crowdSize > MAX_CROWD_SIZE
  )
    throw new Error(`NFT_CROWD_SIZE must be 0–${MAX_CROWD_SIZE}.`);
  const publicConfig = {
    VITE_THRUPUT_NETWORK_ID: env.VITE_THRUPUT_NETWORK_ID,
    VITE_NFT_DROP_FACTORY: env.VITE_NFT_DROP_FACTORY,
    NFT_CROWD_SIZE: String(crowdSize),
  };
  return {
    rpcUrl,
    app: parseConfig(publicConfig),
    crowdSeed,
    crowdSize,
    publicConfig,
  };
}

export type ServerConfig = ReturnType<typeof loadConfig>;
