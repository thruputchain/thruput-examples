import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadConfig } from "./server/config";
import { createApiHandler, json } from "./server/http";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    base: process.env.APP_BASE_PATH || "/",
    envPrefix: [],
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "voting-public-config",
        configureServer(server) {
          if (mode === "test") return;
          const api = createApiHandler(loadConfig(env));
          server.middlewares.use((request, response, next) => {
            void api(request, response)
              .then((handled) => {
                if (!handled) next();
              })
              .catch(() =>
                json(response, 500, { error: "Voting API is unavailable." }),
              );
          });
        },
      },
    ],
    server: { cors: false },
    test: { setupFiles: ["./src/test/setup.ts"] },
  };
});
