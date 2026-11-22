import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadServerConfig } from "./server/config.ts";
import { createApiHandler, json } from "./server/http.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ command, mode }) => ({
  base: process.env.APP_BASE_PATH || "/",
  // Public configuration is served at runtime; no environment values enter the bundle.
  envPrefix: [],
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "swap-api",
      configureServer(server) {
        if (command !== "serve" || mode === "test" || mode === "browser-test")
          return;
        const api = createApiHandler(
          loadServerConfig({ ...loadEnv(mode, root, ""), ...process.env }),
        );
        server.middlewares.use((request, response, next) => {
          void api(request, response)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(() => json(response, 500, { error: "Server error." }));
        });
      },
    },
  ],
  server: {
    cors: false,
    headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
    // Token search calls the Launchpad app's API. The hosted gateway serves
    // both apps on one origin; locally, forward to the Launchpad dev server.
    proxy: {
      "/launchpad/api": {
        target: "http://127.0.0.1:5173",
        rewrite: (url) => url.replace(/^\/launchpad/, ""),
      },
    },
  },
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost" } },
    setupFiles: ["./src/test/setup.ts"],
  },
}));
