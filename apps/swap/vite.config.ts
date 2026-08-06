import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  envPrefix: [
    "VITE_GROUNDHOG_RPC_URL",
    "VITE_GROUNDHOG_NETWORK_ID",
    "VITE_GROUNDHOG_WALLET_ADDRESS",
    "VITE_SWAP_ROUTER_ADDRESS",
    "VITE_SWAP_PAIR_ADDRESS",
    "VITE_SWAP_HANDLER_ADDRESS",
    "VITE_SWAP_DRIVER_ADDRESS",
    "VITE_TOKEN_A_ADDRESS",
    "VITE_TOKEN_B_ADDRESS",
    "VITE_TOKEN_A_SYMBOL",
    "VITE_TOKEN_B_SYMBOL",
    "VITE_TOKEN_DECIMALS",
  ],
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
  test: {
    environment: "jsdom",
  },
});
