import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorMessage, hex32, parseHttpUrl } from "../src/config";
import { provisionCounter } from "./provision";

export async function setupDevnet(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const url = parseHttpUrl(
    env.GROUNDHOG_RPC_URL || "https://rpc.thruput.network",
  );
  if (url.protocol !== "https:")
    throw new Error("Devnet setup requires HTTPS.");
  await provisionCounter({
    network: "devnet",
    rpcUrl: url.href,
    networkId: hex32(env.GROUNDHOG_NETWORK_ID, "GROUNDHOG_NETWORK_ID"),
    output:
      env.COUNTER_APP_ENV ||
      fileURLToPath(new URL("../.env.devnet", import.meta.url)),
    artifact: env.COUNTER_ARTIFACT,
    explorerUrl: env.VITE_EXPLORER_URL,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setupDevnet().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
