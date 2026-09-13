import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provisionLaunchpad } from "./provision";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!env.GROUNDHOG_RUNTIME_MANIFEST)
    throw new Error("GROUNDHOG_RUNTIME_MANIFEST is required");
  const manifest: {
    networkHash?: unknown;
    bootstrap?: { storageCostModel?: unknown };
  } = JSON.parse(
    await readFile(
      resolve(repositoryRoot, env.GROUNDHOG_RUNTIME_MANIFEST),
      "utf8",
    ),
  );
  if (typeof manifest.networkHash !== "string")
    throw new Error("Runtime manifest is missing networkHash");
  const networkId = normalizeNetworkHash(manifest.networkHash);
  if (
    env.GROUNDHOG_NETWORK_ID !== undefined &&
    normalizeNetworkHash(env.GROUNDHOG_NETWORK_ID) !== networkId
  ) {
    throw new Error("Runtime manifest and GROUNDHOG_NETWORK_ID disagree");
  }
  await provisionLaunchpad({
    network: "local",
    networkId,
    rpcUrl: validateLocalRpcUrl(
      env.GROUNDHOG_RPC_URL || "http://127.0.0.1:9545",
    ),
    output: env.LAUNCHPAD_APP_ENV || "apps/token-launchpad/.env.local",
    storageCosts: manifest.bootstrap?.storageCostModel,
    artifactRoot: env.LAUNCHPAD_ARTIFACT_ROOT,
    publicDirectory: env.LAUNCHPAD_APP_PUBLIC_DIR,
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
  const match = /^(?:0x)?([0-9a-f]{64})$/i.exec(value);
  if (!match) throw new Error("Invalid local network hash");
  return `0x${match[1]!.toLowerCase()}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Launchpad setup failed.",
    );
    process.exitCode = 1;
  });
}
