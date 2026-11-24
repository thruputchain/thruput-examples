import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { developmentServer } from "./server/development.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ command, mode }) => ({
  base: process.env.APP_BASE_PATH || "/",
  // Public configuration is served at runtime; no environment values enter the bundle.
  envPrefix: [],
  plugins: [
    react(),
    tailwindcss(),
    ...(command === "serve" && mode !== "test" && mode !== "browser-test"
      ? [
          developmentServer({
            ...loadEnv(mode, root, ""),
            ...process.env,
          }),
        ]
      : []),
  ],
  server: {
    cors: false,
    headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
  },
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost" } },
    setupFiles: ["./src/test/setup.ts"],
  },
}));
