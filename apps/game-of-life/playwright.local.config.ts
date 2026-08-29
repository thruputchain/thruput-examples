import { defineConfig } from "@playwright/test";

const baseURL = process.env.GAME_OF_LIFE_APP_URL;
if (!baseURL) throw new Error("GAME_OF_LIFE_APP_URL is required");

export default defineConfig({
  testDir: "tests/live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  outputDir: "test-results/live",
  use: {
    browserName: "chromium",
    baseURL,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: [
        "--enable-precise-memory-info",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
      ],
    },
  },
});
