import { resolve } from "node:path";
import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  toBase58,
} from "@thruputchain/client";
import {
  address,
  hash,
  parseTokens,
  type PublicConfig,
} from "../shared/config";

export interface Policy {
  cooldownMs: number;
  ipWindowMs: number;
  ipClaims: number;
  dailyClaims: number;
  requestsPerMinute: number;
  maxRecords: number;
}
export const DEFAULT_POLICY: Policy = {
  cooldownMs: 24 * 60 * 60_000,
  ipWindowMs: 60 * 60_000,
  ipClaims: 10,
  dailyClaims: 1_000,
  requestsPerMinute: 60,
  maxRecords: 10_000,
};
export function loadConfig(env: Record<string, string | undefined>) {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Set ${key}. Run setup:local first.`);
    return value;
  };
  const integer = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}.`);
    return value;
  };
  const rpc = new URL(required("THRUPUT_RPC_URL"));
  const local =
    rpc.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  if (
    (!local && rpc.protocol !== "https:") ||
    rpc.username ||
    rpc.password ||
    rpc.search ||
    rpc.hash
  )
    throw new Error("Use HTTPS RPC or loopback HTTP.");
  const secret = required("FAUCET_SIGNING_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret))
    throw new Error("Invalid faucet signing key.");
  const account = createPubkeyAccount({
    signer: new Ed25519Signer(fromHex0x(secret)),
  });
  const faucetAddress = address(required("FAUCET_ADDRESS"));
  if (toBase58(account.address) !== faucetAddress)
    throw new Error("Faucet key does not match FAUCET_ADDRESS.");
  const proxySecret = env.FAUCET_PROXY_SECRET || null;
  if (proxySecret !== null && !/^[0-9a-f]{64}$/.test(proxySecret))
    throw new Error("FAUCET_PROXY_SECRET must be 32 random hex bytes.");
  if (!local && !proxySecret)
    throw new Error(
      "Remote deployments require FAUCET_PROXY_SECRET and the trusted gateway.",
    );
  const ipSalt = required("FAUCET_IP_SALT");
  if (!/^[0-9a-f]{64}$/.test(ipSalt))
    throw new Error("FAUCET_IP_SALT must be 32 random hex bytes.");
  const policy: Policy = {
    ...DEFAULT_POLICY,
    cooldownMs: integer("FAUCET_COOLDOWN_SECONDS", 86400, 604800) * 1000,
    ipClaims: integer("FAUCET_IP_CLAIMS_PER_HOUR", 10, 1000),
    dailyClaims: integer("FAUCET_CLAIMS_PER_DAY", 1000, 10000),
    requestsPerMinute: integer("FAUCET_REQUESTS_PER_MINUTE", 60, 1000),
  };
  const swap = new URL(env.SWAP_APP_URL || "http://127.0.0.1:5174/");
  if (
    (swap.protocol !== "https:" &&
      !(
        local &&
        swap.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(swap.hostname)
      )) ||
    swap.username ||
    swap.password ||
    swap.search ||
    swap.hash
  )
    throw new Error("Invalid SWAP_APP_URL.");
  const anchorHeight = required("FAUCET_ANCHOR_HEIGHT");
  if (!/^[1-9][0-9]{0,18}$/.test(anchorHeight))
    throw new Error("Invalid FAUCET_ANCHOR_HEIGHT.");
  const publicConfig: PublicConfig = {
    networkId: hash(required("THRUPUT_NETWORK_ID")),
    anchorHeight,
    anchorHash: hash(required("FAUCET_ANCHOR_HASH")),
    faucetAddress,
    tokens: parseTokens(JSON.parse(required("FAUCET_TOKENS"))),
    cooldownSeconds: policy.cooldownMs / 1000,
    swapUrl: swap.href,
  };
  if (publicConfig.tokens.some((t) => t.address === faucetAddress))
    throw new Error("Faucet cannot also be a configured token.");
  return {
    account,
    rpcUrl: rpc.href,
    publicConfig,
    policy,
    proxySecret,
    ipSalt,
    databasePath: resolve(required("FAUCET_DB_PATH")),
    port: integer("PORT", 5177, 65535),
    host: proxySecret ? "::" : "127.0.0.1",
  };
}
export type ServerConfig = ReturnType<typeof loadConfig>;
