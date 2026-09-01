import { defineConfig } from "@playwright/test";
import { fromHex0x, PrivateKeySigner, toHex0x } from "@groundhogchain/client";

const personas = (["alice", "bob", "carol"] as const).map((id, index) => {
  const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
  const signer = new PrivateKeySigner(fromHex0x(privateKey));
  const walletRoot = `0x${(index + 10).toString(16).padStart(64, "0")}`;
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    privateKey,
    signerPublicKey: toHex0x(signer.publicKey.ed25519),
    walletRoot,
    walletEntrypoint: "0xa0fff94c64fbaf3c",
    expectedCaller: walletRoot,
    callerVerified: true,
  };
});
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
      VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "100000",
      VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "100000",
      VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
      VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
      VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: "10010000000",
      VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000000",
      VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "2",
      VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
      GROUNDHOG_DEV_PERSONAS: JSON.stringify(personas),
    },
  },
});
