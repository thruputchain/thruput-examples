import { mkdir } from "node:fs/promises";
import path from "node:path";

import { loadServerConfig } from "./config.ts";
import { createRegistryHttpServer } from "./http.ts";
import { RegistryStore } from "./store.ts";

const config = loadServerConfig(process.env);
await mkdir(path.dirname(config.databasePath), { recursive: true });

const store = new RegistryStore(config.databasePath, config.scope);
const server = createRegistryHttpServer(store, { requestSync() {} });

server.listen(config.port, "0.0.0.0", () => {
  console.log(
    `Token registry listening on port ${config.port} for network ${config.scope.networkId.slice(0, 12)}...`,
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  store.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
