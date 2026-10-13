import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { loadServerConfig } from "./config.ts";
import { createThruputRegistrySource } from "./chain.ts";
import { createRegistryHttpServer } from "./http.ts";
import { RegistryIndexer } from "./indexer.ts";
import { RegistryStore } from "./store.ts";
import { publicConfig } from "./public-config.ts";

/** Development uses the same registry API and indexer as the production server. */
export function developmentRegistry(
  environment: Record<string, string>,
): Plugin {
  let stop: (() => Promise<void>) | undefined;
  return {
    name: "token-registry",
    async configureServer(vite) {
      const browserConfig = publicConfig(environment);
      const config = loadServerConfig({
        ...environment,
        PORT: "1",
        TOKEN_REGISTRY_DB_PATH:
          environment.TOKEN_REGISTRY_DB_PATH ||
          path.join(
            vite.config.root,
            ".local",
            `${environment.VITE_STANDARD_TOKEN_FACTORY_ADDRESS}.sqlite`,
          ),
      });
      const source = await createThruputRegistrySource(config);
      await mkdir(path.dirname(config.databasePath), { recursive: true });
      const store = new RegistryStore(config.databasePath, config.scope);
      const indexer = new RegistryIndexer(store, source, {
        pageSize: config.pageSize,
        syncIntervalMs: config.syncIntervalMs,
      });
      let stopping: Promise<void> | undefined;
      stop = () => (stopping ??= indexer.stop().finally(() => store.close()));
      const api = createRegistryHttpServer(store, indexer, { rpcUrl: config.rpcUrl, publicConfig: browserConfig });
      vite.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/api/") || request.url?.startsWith("/thruput-rpc") || request.url === "/healthz")
          api.emit("request", request, response);
        else next();
      });
      indexer.start();
    },
    async closeBundle() {
      await stop?.();
    },
  };
}
