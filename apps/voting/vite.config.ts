import { defineConfig, loadEnv, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.THRUPUT_RPC_URL || "http://127.0.0.1:9545";
  const url = new URL(target);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Voting requires a localnode HTTP endpoint.");
  }
  const proxy = { "/thruput-rpc": { target, rewrite: () => "/" } };
  const config: Connect.NextHandleFunction = (request, response, next) => {
    if (request.url !== "/api/config") return next();
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      JSON.stringify({
        VITE_THRUPUT_NETWORK_ID: env.VITE_THRUPUT_NETWORK_ID,
        VITE_VOTING_ADDRESS: env.VITE_VOTING_ADDRESS,
      }),
    );
  };
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "voting-public-config",
        configureServer(server) {
          server.middlewares.use(config);
        },
        configurePreviewServer(server) {
          server.middlewares.use(config);
        },
      },
    ],
    server: { proxy },
    preview: { proxy },
    test: { setupFiles: ["./src/test/setup.ts"] },
  };
});
