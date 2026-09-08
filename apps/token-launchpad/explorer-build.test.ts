// @vitest-environment node
import { build } from "vite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import viteConfig from "./vite.config";
import { parsePublicConfigManifest } from "./server/public-config-manifest";
import { hashContract, toHex0x } from "@groundhogchain/client";
import { ContractType } from "@groundhogchain/protocol";

const environment = vi.hoisted(() => ({
  VITE_GROUNDHOG_RPC_URL: "https://fixture-rpc.test/private-upstream",
  VITE_GROUNDHOG_NETWORK_ID: "11".repeat(32),
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
let publicDir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (publicDir) await rm(publicDir, { recursive: true, force: true });
});

it("builds production with explicit explorer exposure and a matching manifest, without secrets", async () => {
  environment.VITE_STANDARD_TOKEN_HASH = toHex0x(
    hashContract({
      contract_type: ContractType.kRv32,
      rv32_contract: { data: new Uint8Array([1, 2, 3]) },
    }),
  );
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
  publicDir = await mkdtemp(path.join(tmpdir(), "launchpad-public-"));
  await mkdir(path.join(publicDir, "contract-artifacts"));
  const artifact = JSON.stringify({
    contractType: "rv32",
    data: "0x010203",
    hash: environment.VITE_STANDARD_TOKEN_HASH,
  });
  await writeFile(
    path.join(
      publicDir,
      `contract-artifacts/${environment.VITE_STANDARD_TOKEN_HASH}.json`,
    ),
    artifact,
  );
  const result = await build({
    ...config,
    configFile: false,
    envDir: false,
    publicDir,
    logLevel: "silent",
    build: { outDir: "dist/explorer-fixture", emptyOutDir: true },
  });
  if (!("output" in result)) throw new Error("Expected one build output");
  expect(
    await readFile(
      `dist/explorer-fixture/contract-artifacts/${environment.VITE_STANDARD_TOKEN_HASH}.json`,
      "utf8",
    ),
  ).toBe(artifact);
  const javascript = result.output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  expect(javascript).toContain(environment.VITE_EXPLORER_URL);
  expect(javascript).not.toContain(environment.GROUNDHOG_DEV_PERSONAS);
  expect(javascript).not.toContain("GROUNDHOG_DEV_PERSONAS");
  expect(javascript).not.toContain("DevelopmentWalletSwitcher");
  expect(javascript).not.toContain(
    "The generated development wallet is invalid",
  );
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

it.each(["missing", "malformed", "mismatched"])(
  "rejects production builds with a %s artifact",
  async (failure) => {
    publicDir = await mkdtemp(path.join(tmpdir(), "launchpad-invalid-public-"));
    await mkdir(path.join(publicDir, "contract-artifacts"));
    if (failure !== "missing")
      await writeFile(
        path.join(
          publicDir,
          `contract-artifacts/${environment.VITE_STANDARD_TOKEN_HASH}.json`,
        ),
        failure === "malformed"
          ? "{}"
          : JSON.stringify({
              contractType: "rv32",
              data: "0x040506",
              hash: environment.VITE_STANDARD_TOKEN_HASH,
            }),
      );
    if (typeof viteConfig !== "function")
      throw new Error("Expected config factory");
    const config = await viteConfig({
      command: "build",
      mode: "production",
      isPreview: false,
    });
    await expect(
      build({
        ...config,
        configFile: false,
        envDir: false,
        publicDir,
        logLevel: "silent",
        build: { write: false },
      }),
    ).rejects.toThrow(/artifact/);
  },
);
