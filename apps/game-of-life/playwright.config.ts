import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4176",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: {
    command: "npm run dev -- --mode e2e --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    env: {
      VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:4176",
      VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
      VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"22".repeat(32)}`,
      VITE_GAME_OF_LIFE_INDEXER_URL: "http://127.0.0.1:4176",
    },
  },
});
