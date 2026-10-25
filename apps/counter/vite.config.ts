import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { loadServerConfig, type ServerConfig } from "./server/config";
import { createApiHandler, json } from "./server/http";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => {
  let config: ServerConfig | Error;
  try {
    config = loadServerConfig({ ...loadEnv(mode, root, ""), ...process.env });
  } catch (error) {
    config =
      error instanceof Error
        ? error
        : new Error("Run setup:local to configure Counter.");
  }
  const api: Plugin = {
    name: "counter-api",
    configureServer(server) {
      const handleApi = createApiHandler(config);
      server.middlewares.use((request, response, next) => {
        void handleApi(request, response)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(() =>
            json(response, 500, { error: "Counter API is unavailable." }),
          );
      });
    },
  };
  return {
    plugins: [react(), tailwindcss(), api],
    // All app configuration comes from the same runtime endpoint in dev and production.
    envPrefix: [],
    server: {
      cors: false,
      headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
    },
    test: { environment: "node", setupFiles: ["./src/test/setup.ts"] },
  };
});
