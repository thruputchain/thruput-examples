// @vitest-environment node
import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import viteConfig from "./vite.config";
import { parsePublicConfigManifest } from "./server/public-config-manifest";

const environment = vi.hoisted(() => ({
  VITE_GROUNDHOG_RPC_URL: "https://fixture-rpc.test/private-upstream",
  VITE_GROUNDHOG_NETWORK_ID: "11".repeat(32),
  VITE_GROUNDHOG_WALLET_ADDRESS: `0x${"22".repeat(32)}`,
  VITE_GROUNDHOG_WALLET_ENTRYPOINT: `0x${"33".repeat(8)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"55".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: `0x${"66".repeat(32)}`,
  VITE_TOKEN_REGISTRY_ENABLED: "true",
  VITE_SWAP_APP_URL: "",
  VITE_EXPLORER_URL: "https://EXPLORER.fixture.test:443/",
  GROUNDHOG_DEV_PERSONAS: "fixture-private-personas-never-expose",
  VITE_UNRELATED_SECRET: "fixture-unrelated-secret-never-expose",
}));
vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  loadEnv: () => environment,
}));
afterEach(() => vi.unstubAllEnvs());

it("builds production with explicit explorer exposure and a matching manifest, without secrets", async () => {
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  if (typeof viteConfig !== "function")
    throw new Error("Expected Vite config factory");
  const config = await viteConfig({
    command: "build",
    mode: "production",
    isPreview: false,
  });
  expect(config.envPrefix).toContain("VITE_EXPLORER_URL");
  const result = await build({
    ...config,
    configFile: false,
    envDir: false,
    logLevel: "silent",
    build: { outDir: "dist/explorer-fixture", emptyOutDir: true },
  });
  if (!("output" in result)) throw new Error("Expected one build output");
  const javascript = result.output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  expect(javascript).toContain(environment.VITE_EXPLORER_URL);
  expect(javascript).not.toContain(environment.GROUNDHOG_DEV_PERSONAS);
  expect(javascript).not.toContain(environment.VITE_UNRELATED_SECRET);
  expect(javascript).not.toContain(environment.VITE_GROUNDHOG_RPC_URL);
  const manifest = result.output.find(
    (item) => item.fileName === "groundhog-public-config.json",
  );
  if (manifest?.type !== "asset") throw new Error("Missing manifest");
  expect(
    parsePublicConfigManifest(String(manifest.source)).VITE_EXPLORER_URL,
  ).toBe("https://explorer.fixture.test");
}, 30_000);
