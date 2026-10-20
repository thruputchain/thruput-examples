import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorMessage, hash58, parseHttpUrl } from "../src/config";
import { provisionCounter } from "./provision";

export async function setup(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const url = parseHttpUrl(env.THRUPUT_RPC_URL || "http://127.0.0.1:9545");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Local setup requires a loopback HTTP RPC URL.");
  }
  if (!env.THRUPUT_RUNTIME_MANIFEST)
    throw new Error(
      "Set THRUPUT_RUNTIME_MANIFEST to the node's runtime manifest.",
    );
  const manifest: { networkHash?: unknown } = JSON.parse(
    await readFile(
      resolve(
        fileURLToPath(new URL("../../../", import.meta.url)),
        env.THRUPUT_RUNTIME_MANIFEST,
      ),
      "utf8",
    ),
  );
  await provisionCounter({
    network: "local",
    rpcUrl: url.href,
    networkId: hash58(manifest.networkHash, "Runtime network hash"),
    output:
      env.COUNTER_APP_ENV ||
      fileURLToPath(new URL("../.env.local", import.meta.url)),
    artifact: env.COUNTER_ARTIFACT,
    explorerUrl: env.VITE_EXPLORER_URL,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setup().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
