// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPublicConfigManifest,
  parsePublicConfigManifest,
  PublicConfigManifestError,
  verifyPublicConfigManifest,
} from "./public-config-manifest.ts";

const rpcUrl = "https://rpc.example.test/groundhog";
const environment = {
  VITE_GROUNDHOG_RPC_URL: rpcUrl,
  VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
  VITE_GROUNDHOG_WALLET_ADDRESS: `0x${"22".repeat(32)}`,
  VITE_GROUNDHOG_WALLET_ENTRYPOINT: `0x${"AB".repeat(8)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
  VITE_KNOWN_TOKEN_ADDRESSES: `0x${"66".repeat(32)},0x${"55".repeat(32)},0x${"66".repeat(32)}`,
  VITE_SWAP_FACTORY_ADDRESS: `0x${"77".repeat(32)}`,
  VITE_SWAP_ROUTER_ADDRESS: `0x${"88".repeat(32)}`,
  VITE_POOL_REGISTRY_ENABLED: "true",
};

describe("production public configuration manifest", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("contains exactly normalized public values and an RPC digest", () => {
    const manifest = createPublicConfigManifest({
      ...environment,
      PRIVATE_SECRET: "do-not-emit",
    });
    expect(manifest).toEqual({
      VITE_GROUNDHOG_RPC_URL_SHA256: createHash("sha256")
        .update(new URL(rpcUrl).href)
        .digest("hex"),
      VITE_GROUNDHOG_NETWORK_ID: "aa".repeat(32),
      VITE_GROUNDHOG_WALLET_ADDRESS: `0x${"22".repeat(32)}`,
      VITE_GROUNDHOG_WALLET_ENTRYPOINT: `0x${"ab".repeat(8)}`,
      VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
      VITE_KNOWN_TOKEN_ADDRESSES: `0x${"66".repeat(32)},0x${"55".repeat(32)}`,
      VITE_SWAP_FACTORY_ADDRESS: `0x${"77".repeat(32)}`,
      VITE_SWAP_ROUTER_ADDRESS: `0x${"88".repeat(32)}`,
      VITE_POOL_REGISTRY_ENABLED: "true",
    });
    expect(JSON.stringify(manifest)).not.toContain(rpcUrl);
    expect(JSON.stringify(manifest)).not.toContain("do-not-emit");
  });

  it.each([
    ["VITE_GROUNDHOG_RPC_URL", "https://user:secret@rpc.example.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://rpc.example.test/?key=secret"],
    ["VITE_GROUNDHOG_NETWORK_ID", "aa"],
    ["VITE_GROUNDHOG_WALLET_ADDRESS", "22".repeat(32)],
    ["VITE_GROUNDHOG_WALLET_ENTRYPOINT", "0x12"],
    ["VITE_KNOWN_TOKEN_ADDRESSES", "not-an-address"],
    ["VITE_SWAP_FACTORY_ADDRESS", "0x12"],
    ["VITE_SWAP_ROUTER_ADDRESS", "0x12"],
    ["VITE_POOL_REGISTRY_ENABLED", "TRUE"],
  ])("rejects malformed %s without leaking its value", (key, value) => {
    let error: unknown;
    try {
      createPublicConfigManifest({ ...environment, [key]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PublicConfigManifestError);
    expect((error as Error).message).toContain(key);
    expect((error as Error).message).not.toContain(value);
  });

  it("strictly rejects missing, extra, non-string, and noncanonical fields", () => {
    const manifest = createPublicConfigManifest(environment);
    expect(() => parsePublicConfigManifest("[]")).toThrow(/invalid shape/);
    expect(() =>
      parsePublicConfigManifest(JSON.stringify({ ...manifest, extra: "x" })),
    ).toThrow(/unexpected fields/);
    const { VITE_SWAP_ROUTER_ADDRESS: _missing, ...missing } = manifest;
    expect(() => parsePublicConfigManifest(JSON.stringify(missing))).toThrow(
      /unexpected fields/,
    );
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({ ...manifest, VITE_POOL_REGISTRY_ENABLED: true }),
      ),
    ).toThrow(/VITE_POOL_REGISTRY_ENABLED/);
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({
          ...manifest,
          VITE_GROUNDHOG_WALLET_ADDRESS:
            manifest.VITE_GROUNDHOG_WALLET_ADDRESS.toUpperCase(),
        }),
      ),
    ).toThrow(/VITE_GROUNDHOG_WALLET_ADDRESS/);
  });

  it("compares normalized runtime semantics without exposing mismatched values", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "swap-manifest-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(createPublicConfigManifest(environment)),
    );

    await expect(
      verifyPublicConfigManifest(manifestPath, {
        ...environment,
        VITE_GROUNDHOG_NETWORK_ID: "aa".repeat(32),
        VITE_KNOWN_TOKEN_ADDRESSES: `0x${"66".repeat(32)},0x${"55".repeat(32)}`,
      }),
    ).resolves.toBeDefined();
    const secret = "https://distinctive-secret.example.test";
    const failure = verifyPublicConfigManifest(manifestPath, {
      ...environment,
      VITE_GROUNDHOG_RPC_URL: secret,
    });
    await expect(failure).rejects.toThrow(
      /VITE_GROUNDHOG_RPC_URL does not match/,
    );
    await expect(failure).rejects.not.toThrow(/distinctive-secret/);
  });
});
