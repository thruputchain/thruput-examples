import { defineConfig, loadEnv } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { startFaucet } from "./server/runtime";
import { createApiHandler, json } from "./server/http";

export default defineConfig(({ mode }) => ({
  base: process.env.APP_BASE_PATH || "/",
  envPrefix: [],
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "token-faucet-api",
      async configureServer(server) {
        if (mode === "test") return;
        const selected = process.env.FAUCET_ENV_PATH
          ? parseEnv(
              await readFile(
                resolve(
                  fileURLToPath(new URL("../../", import.meta.url)),
                  process.env.FAUCET_ENV_PATH,
                ),
                "utf8",
              ),
            )
          : {};
        const runtime = await startFaucet({
          ...loadEnv(mode, process.cwd(), ""),
          ...selected,
          ...process.env,
        });
        const api = createApiHandler(runtime.config, runtime.claims);
        server.httpServer?.once("close", () => {
          void runtime.close();
        });
        server.middlewares.use((request, response, next) => {
          void api(request, response)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(() =>
              json(response, 503, { error: "Faucet is unavailable." }),
            );
        });
      },
    },
  ],
  server: { cors: false },
}));
