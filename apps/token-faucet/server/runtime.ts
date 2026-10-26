import { mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { createClaimChain } from "./chain";
import { Claims } from "./claims";
import { ClaimStore } from "./store";

export async function startFaucet(env: Record<string, string | undefined>) {
  const config = loadConfig(env);
  await mkdir(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const chain = await createClaimChain(config);
  const store = new ClaimStore(
    config.databasePath,
    config.publicConfig,
    config.policy,
  );
  const claims = new Claims(config.publicConfig, store, chain);
  try {
    await chmod(config.databasePath, 0o600);
    await claims.start();
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    config,
    claims,
    async close() {
      await claims.stop();
      store.close();
    },
  };
}
