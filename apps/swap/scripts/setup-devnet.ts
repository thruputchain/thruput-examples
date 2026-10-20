import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalNetworkId } from "../server/validation";
import { provisionSwap } from "./provision";

export async function setupDevnet(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const rpcUrl = validateDevnetRpcUrl(
    env.THRUPUT_RPC_URL || "https://rpc.thruput.network",
  );
  await provisionSwap({
    network: "devnet",
    rpcUrl,
    networkId: validateNetworkId(env.THRUPUT_NETWORK_ID ?? ""),
    output: env.SWAP_APP_ENV || "apps/swap/.env.devnet",
    artifactRoot: env.SWAP_ARTIFACT_ROOT,
    publicDirectory: env.SWAP_APP_PUBLIC_DIR,
    explorerUrl: env.VITE_EXPLORER_URL ?? "https://explorer.thruput.network",
  });
}

function validateNetworkId(value: string): string {
  return canonicalNetworkId(value, "THRUPUT_NETWORK_ID");
}

export function validateDevnetRpcUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "Devnet setup requires an HTTPS RPC URL without credentials, a query, or a fragment",
    );
  }
  return url.href;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setupDevnet().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Swap Devnet setup failed.",
    );
    process.exitCode = 1;
  });
}
