import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plugin } from "vite";
import { loadServerConfig } from "./config.ts";
import { createApiHandler, json } from "./http.ts";
import { createIndexerClient, startIndexer } from "./indexer.ts";
import { TokenStore } from "./store.ts";

/** The dev server runs the same API and indexer as the production server. */
export function developmentServer(
  environment: Record<string, string | undefined>,
): Plugin {
  let stop: (() => void) | undefined;
  return {
    name: "launchpad-api",
    async configureServer(vite) {
      const config = loadServerConfig(environment, vite.config.root);
      await mkdir(dirname(config.databasePath), { recursive: true });
      const store = new TokenStore(config.databasePath);
      const indexer = startIndexer(
        await createIndexerClient(config),
        store,
        config.factoryAddress,
      );
      stop = () => {
        indexer.stop();
        store.close();
      };
      const api = createApiHandler(config, store, indexer.status);
      vite.middlewares.use((request, response, next) => {
        void api(request, response)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(() => json(response, 500, { error: "Server error." }));
      });
    },
    closeBundle() {
      stop?.();
    },
  };
}
