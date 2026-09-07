import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadServerConfig } from "./config.ts";
import { createGroundhogRegistrySource } from "./chain.ts";
import { createRegistryHttpServer } from "./http.ts";
import { RegistryIndexer } from "./indexer.ts";
import {
  PUBLIC_CONFIG_MANIFEST_FILENAME,
  verifyPublicConfigManifest,
} from "./public-config-manifest.ts";
import { RegistryStore } from "./store.ts";

const config = loadServerConfig(process.env);
const staticDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
await verifyPublicConfigManifest(
  path.join(staticDirectory, PUBLIC_CONFIG_MANIFEST_FILENAME),
  process.env,
);
const indexStat = await stat(path.join(staticDirectory, "index.html"));
if (!indexStat.isFile()) throw new Error("Production index.html is missing");
const source = await createGroundhogRegistrySource(config);
await mkdir(path.dirname(config.databasePath), { recursive: true });

const store = new RegistryStore(config.databasePath, config.scope);
const indexer = new RegistryIndexer(store, source, {
  pageSize: config.pageSize,
  syncIntervalMs: config.syncIntervalMs,
});
const server = createRegistryHttpServer(store, indexer, {
  staticDirectory,
  rpcUrl: config.rpcUrl,
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
} catch (error) {
  store.close();
  throw error;
}
indexer.start();
console.log(
  `Token registry listening on port ${config.port}; network=${summary(config.scope.networkId)} factory=${summary(config.scope.factoryAddress)} tokenHash=${summary(config.scope.tokenCodeHash)}`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await indexer.stop();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  store.close();
}

function handleShutdown(): void {
  void shutdown().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Shutdown failed");
    process.exitCode = 1;
  });
}

process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);

function summary(value: string): string {
  return `${value.slice(0, 14)}...`;
}
