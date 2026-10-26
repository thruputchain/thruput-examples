import {
  address,
  hash,
  parseTokens,
  type PublicConfig,
} from "../shared/config";
export function loadConfig(env: Record<string, string | undefined>) {
  const rpc = new URL(env.THRUPUT_RPC_URL || "http://127.0.0.1:9545");
  if (
    (rpc.protocol !== "https:" &&
      !(
        rpc.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname)
      )) ||
    rpc.username ||
    rpc.password ||
    rpc.search ||
    rpc.hash
  )
    throw new Error("Use HTTPS RPC or loopback HTTP.");
  const swap = new URL(env.SWAP_APP_URL || "http://127.0.0.1:5174/");
  if (
    !["http:", "https:"].includes(swap.protocol) ||
    swap.username ||
    swap.password
  )
    throw new Error("Invalid Swap URL.");
  const anchorHeight = env.AIRDROP_ANCHOR_HEIGHT || "1";
  if (!/^[1-9][0-9]{0,18}$/.test(anchorHeight))
    throw new Error("Invalid chain checkpoint height.");
  const publicConfig: PublicConfig = {
    networkId: hash(env.THRUPUT_NETWORK_ID || ""),
    anchorHeight,
    anchorHash: hash(env.AIRDROP_ANCHOR_HASH || ""),
    address: address(env.AIRDROP_ADDRESS || ""),
    tokens: parseTokens(JSON.parse(env.AIRDROP_TOKENS || "null")),
    swapUrl: swap.href,
  };
  return { rpcUrl: rpc.href, publicConfig };
}
export type ServerConfig = ReturnType<typeof loadConfig>;
