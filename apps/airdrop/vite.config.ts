import { defineConfig, loadEnv } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadConfig } from "./server/config";
import { createApiHandler, json } from "./server/http";

export default defineConfig(({ mode }) => ({
  base: process.env.APP_BASE_PATH || "/",
  envPrefix: [],
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "airdrop-api",
      async configureServer(server) {
        if (mode === "test") return;
        const selected = process.env.AIRDROP_ENV_PATH
          ? parseEnv(
              await readFile(
                resolve(
                  fileURLToPath(new URL("../../", import.meta.url)),
                  process.env.AIRDROP_ENV_PATH,
                ),
                "utf8",
              ),
            )
          : {};
        const config = loadConfig({
          ...loadEnv(mode, process.cwd(), ""),
          ...selected,
          ...process.env,
        });
        const api = createApiHandler(config);
        server.middlewares.use((request, response, next) => {
          void api(request, response)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(() =>
              json(response, 503, { error: "Airdrop API is unavailable." }),
            );
        });
      },
    },
  ],
  server: { cors: false },
}));
