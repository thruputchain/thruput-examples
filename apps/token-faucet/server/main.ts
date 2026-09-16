import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { durableMkdir, saveJson } from "../../../scripts/seed/seed-journal.ts";
import { connectChain } from "./chain.ts";
import { ClaimService } from "./claims.ts";
import { readManifest } from "./config.ts";
import { faucetServer } from "./http.ts";
import { acquireStateLock } from "./state-lock.ts";

const manifest = await readManifest(
  resolve(process.env.FAUCET_MANIFEST ?? "deployments/devnet.json"),
  process.env.FAUCET_SWAP_URL,
);
const directory = resolve(process.env.FAUCET_STATE_DIR ?? ".local/claims");
await durableMkdir(directory);
const releaseLock = acquireStateLock(directory);
try {
  const scope = JSON.stringify({
    network: manifest.network,
    account: manifest.account,
    tokens: manifest.tokens,
  });
  const scopePath = join(directory, "scope.json");
  const saved = await readFile(scopePath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (saved === null) await saveJson(scopePath, scope);
  else if (JSON.parse(saved) !== scope)
    throw new Error("Faucet state belongs to a different deployment.");
  const chain = await connectChain(
    manifest,
    resolve(process.env.FAUCET_KEY_FILE ?? ".local/devnet/signer.key"),
  );
  const claims = new ClaimService(directory, manifest.tokens, chain);
  const server = faucetServer(manifest, claims, resolve("dist"));
  const port = Number(process.env.PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", accept);
  });
  console.log(`Token faucet listening on port ${port}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((accept) => server.close(() => accept()));
    await claims.drain();
    releaseLock();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  releaseLock();
  throw error;
}
