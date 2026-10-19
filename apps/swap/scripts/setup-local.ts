import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashFromBase58, toBase58 } from "@thruputchain/client";
import { provisionSwap } from "./provision";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let expected =
    env.THRUPUT_NETWORK_ID === undefined
      ? undefined
      : normalizeNetworkHash(env.THRUPUT_NETWORK_ID);
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest: { networkHash?: unknown } = JSON.parse(
      await readFile(
        resolve(repositoryRoot, env.THRUPUT_RUNTIME_MANIFEST),
        "utf8",
      ),
    );
    if (typeof manifest.networkHash !== "string")
      throw new Error("Runtime manifest is missing networkHash");
    const recorded = normalizeNetworkHash(manifest.networkHash);
    if (expected !== undefined && expected !== recorded)
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree");
    expected = recorded;
  }
  await provisionSwap({
    network: "local",
    rpcUrl: validateLocalRpcUrl(
      env.THRUPUT_RPC_URL || "http://127.0.0.1:9545",
    ),
    networkId: expected ?? toBase58(new Uint8Array(32)),
    output: env.SWAP_APP_ENV || "apps/swap/.env.local",
    artifactRoot: env.SWAP_ARTIFACT_ROOT,
    publicDirectory: env.SWAP_APP_PUBLIC_DIR,
  });
}

export function validateLocalRpcUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#") ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Local setup requires a loopback HTTP RPC URL");
  }
  return url.href;
}

function normalizeNetworkHash(value: string): string {
  try {
    const canonical = toBase58(hashFromBase58(value));
    if (canonical === value) return canonical;
  } catch {
    // Reported below.
  }
  throw new Error("Invalid local network hash: expected base58");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Swap setup failed.",
    );
    process.exitCode = 1;
  });
}
