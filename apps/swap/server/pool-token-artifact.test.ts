// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { hashContract, toHex0x } from "@groundhogchain/client";
import { ContractType } from "@groundhogchain/protocol";
import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import viteConfig, { productionPoolTokenArtifact } from "../vite.config.ts";
import { verifyPoolTokenArtifact } from "./pool-token-artifact.ts";

// Serialization/integrity fixture, not proof that a contract executes on a ledger.
const data = new Uint8Array([1, 2, 3]);
const hash = toHex0x(
  hashContract({ contract_type: ContractType.kRv32, rv32_contract: { data } }),
);
const artifact = { contractType: "rv32", data: toHex0x(data), hash };
const relativePath = `contract-artifacts/${hash}.json`;
let directory: string;
let publicDir: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "swap-artifact-"));
  publicDir = path.join(directory, "public");
  await mkdir(path.join(publicDir, "contract-artifacts"), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("served LP artifact validation", () => {
  it("accepts the exact hash-named asset and leaves it unchanged", async () => {
    const contents = JSON.stringify(artifact);
    await writeFile(path.join(publicDir, relativePath), contents);
    await expect(
      verifyPoolTokenArtifact(publicDir, hash),
    ).resolves.toBeUndefined();
    expect(await readFile(path.join(publicDir, relativePath), "utf8")).toBe(
      contents,
    );
  });
  it("rejects a legacy filename and invalid configured hashes", async () => {
    await writeFile(
      path.join(publicDir, "contract-artifacts/erc20.json"),
      JSON.stringify(artifact),
    );
    await expect(verifyPoolTokenArtifact(publicDir, hash)).rejects.toThrow(
      "missing",
    );
    await expect(
      verifyPoolTokenArtifact(publicDir, "../../secret"),
    ).rejects.toThrow("VITE_POOL_TOKEN_HASH");
  });
  it.each([
    "not JSON",
    JSON.stringify({ ...artifact, extra: 1 }),
    JSON.stringify({ ...artifact, data: "0x010204" }),
    JSON.stringify({ ...artifact, hash: `0x${"00".repeat(32)}` }),
    JSON.stringify({ data: artifact.data, hash }),
  ])("rejects invalid schema, JSON or hash %#", async (contents) => {
    await writeFile(path.join(publicDir, relativePath), contents);
    await expect(verifyPoolTokenArtifact(publicDir, hash)).rejects.toThrow();
  });
  it("rejects oversized files and symlinks outside the served directory", async () => {
    const filename = path.join(publicDir, relativePath);
    await writeFile(filename, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(verifyPoolTokenArtifact(publicDir, hash)).rejects.toThrow(
      "8 MiB",
    );
    await rm(filename);
    const outside = path.join(directory, "outside.json");
    await writeFile(outside, JSON.stringify(artifact));
    await symlink(outside, filename);
    await expect(verifyPoolTokenArtifact(publicDir, hash)).rejects.toThrow(
      "inside",
    );
  });
});

describe("production artifact build guard", () => {
  it.each([{ publicDir: false }, { build: { copyPublicDir: false } }] as const)(
    "rejects disabled public asset copying %#",
    async (options) => {
      await expect(
        build({
          configFile: false,
          root: directory,
          logLevel: "silent",
          plugins: [productionPoolTokenArtifact(hash)],
          ...options,
        }),
      ).rejects.toThrow(/publicDir/);
    },
  );
  it.each(["missing", "tampered", "extra fields"])(
    "fails the build for %s assets",
    async (failure) => {
      await writeFile(
        path.join(directory, "index.html"),
        "<main>fixture</main>",
      );
      if (failure !== "missing")
        await writeFile(
          path.join(publicDir, relativePath),
          JSON.stringify(
            failure === "tampered"
              ? { ...artifact, data: "0x04" }
              : { ...artifact, extra: true },
          ),
        );
      await expect(
        build({
          configFile: false,
          root: directory,
          publicDir,
          logLevel: "silent",
          plugins: [productionPoolTokenArtifact(hash)],
        }),
      ).rejects.toThrow(/artifact/);
    },
  );
  it.each([false, true])(
    "builds the actual production app with a controlled publicDir (registry=%s)",
    async (registry) => {
      const address = `0x${"11".repeat(32)}`;
      const environment = {
        VITE_POOL_TOKEN_HASH: hash,
        VITE_EXPLORER_URL: "",
        VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
        VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
        VITE_POOL_REGISTRY_ENABLED: String(registry),
        VITE_TOKEN_DISCOVERY_ENABLED: "false",
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: "",
        VITE_STANDARD_TOKEN_HASH: "",
        TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "",
        VITE_NATIVE_HOG_ADDRESS: address,
        VITE_SWAP_FACTORY_ADDRESS: address,
        VITE_SWAP_ROUTER_ADDRESS: address,
        VITE_KNOWN_TOKEN_ADDRESSES: "",
      };
      for (const [key, value] of Object.entries(environment))
        vi.stubEnv(key, value);
      await writeFile(
        path.join(publicDir, relativePath),
        JSON.stringify(artifact),
      );
      if (typeof viteConfig !== "function")
        throw new Error("Expected config factory");
      const config = await viteConfig({ command: "build", mode: "production" });
      const outDir = path.join(directory, "dist");
      await build({
        ...config,
        configFile: false,
        root: fileURLToPath(new URL("..", import.meta.url)),
        mode: "production",
        publicDir,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      await expect(
        verifyPoolTokenArtifact(outDir, hash),
      ).resolves.toBeUndefined();
      expect(
        JSON.parse(await readFile(path.join(outDir, relativePath), "utf8")),
      ).toEqual(artifact);
      expect(await readFile(path.join(outDir, "index.html"), "utf8")).toContain(
        "<script",
      );
      if (registry)
        expect(
          JSON.parse(
            await readFile(
              path.join(outDir, "groundhog-public-config.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({
          VITE_POOL_TOKEN_HASH: hash,
          VITE_KNOWN_TOKEN_ADDRESSES: "",
        });
    },
    30_000,
  );
});
