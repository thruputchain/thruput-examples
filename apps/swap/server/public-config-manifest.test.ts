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
  VITE_POOL_TOKEN_HASH: `0x${"AB".repeat(32)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
  VITE_SWAP_FACTORY_ADDRESS: `0x${"77".repeat(32)}`,
  VITE_SWAP_ROUTER_ADDRESS: `0x${"88".repeat(32)}`,
  VITE_POOL_REGISTRY_ENABLED: "true",
};

describe("production public configuration manifest", () => {
  it("supports an empty factory without wallet environment", () => {
    const manifest = createPublicConfigManifest(environment);
    expect(parsePublicConfigManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(Object.keys(manifest).some((key) => key.includes("WALLET"))).toBe(false);
  });
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
      VITE_EXPLORER_URL: "",
      VITE_GROUNDHOG_RPC_URL_SHA256: createHash("sha256")
        .update(new URL(rpcUrl).href)
        .digest("hex"),
      VITE_GROUNDHOG_NETWORK_ID: "aa".repeat(32),
      VITE_POOL_TOKEN_HASH: `0x${"ab".repeat(32)}`,
      VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
      VITE_SWAP_FACTORY_ADDRESS: `0x${"77".repeat(32)}`,
      VITE_SWAP_ROUTER_ADDRESS: `0x${"88".repeat(32)}`,
      VITE_POOL_REGISTRY_ENABLED: "true",
      VITE_TOKEN_DISCOVERY_ENABLED: "false",
      VITE_STANDARD_TOKEN_FACTORY_ADDRESS: "",
      VITE_STANDARD_TOKEN_HASH: "",
    });
    expect(JSON.stringify(manifest)).not.toContain(rpcUrl);
    expect(JSON.stringify(manifest)).not.toContain("do-not-emit");
  });

  it.each([
    ["VITE_EXPLORER_URL", "http://remote.example.test"],
    ["VITE_EXPLORER_URL", "https://user:secret@explorer.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://user:secret@rpc.example.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://rpc.example.test/?key=secret"],
    ["VITE_GROUNDHOG_NETWORK_ID", "aa"],
    ["VITE_POOL_TOKEN_HASH", "22".repeat(32)],
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
          VITE_POOL_TOKEN_HASH:
            manifest.VITE_POOL_TOKEN_HASH.toUpperCase(),
        }),
      ),
    ).toThrow(/VITE_POOL_TOKEN_HASH/);
  });

  it("normalizes explorer config, enforces exact manifest fields, and rejects runtime drift", async () => {
    const configured = { ...environment, VITE_EXPLORER_URL: "https://Explorer.test/" };
    const manifest = createPublicConfigManifest(configured);
    expect(manifest.VITE_EXPLORER_URL).toBe("https://explorer.test");
    expect(parsePublicConfigManifest(JSON.stringify(manifest))).toEqual(manifest);
    const { VITE_EXPLORER_URL: _missing, ...old } = manifest;
    expect(() => parsePublicConfigManifest(JSON.stringify(old))).toThrow(/unexpected fields/);
    for (const value of [null, false, " \t\n", "https://explorer.test/", "https://explorer.test/path"]) {
      expect(() => parsePublicConfigManifest(JSON.stringify({ ...manifest, VITE_EXPLORER_URL: value }))).toThrow(/VITE_EXPLORER_URL/);
    }
    directory = await mkdtemp(path.join(os.tmpdir(), "swap-manifest-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyPublicConfigManifest(manifestPath, configured)).resolves.toEqual(manifest);
    await expect(verifyPublicConfigManifest(manifestPath, environment)).rejects.toThrow(/VITE_EXPLORER_URL does not match/);
    await expect(verifyPublicConfigManifest(manifestPath, { ...configured, VITE_EXPLORER_URL: "https://other.test" })).rejects.toThrow(/VITE_EXPLORER_URL does not match/);
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
        VITE_EXPLORER_URL: " \t\n",
        VITE_GROUNDHOG_NETWORK_ID: "aa".repeat(32),
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

  it.each([undefined, "", " \t\r\n"])("normalizes disabled explorer config to an exact blank manifest value: %s", (value) => {
    const manifest = createPublicConfigManifest({ ...environment, VITE_EXPLORER_URL: value });
    expect(manifest.VITE_EXPLORER_URL).toBe("");
    expect(parsePublicConfigManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("round trips discovery scope, rejects drift and requires rebuilding old manifests", async () => {
    const enabled = {
      ...environment,
      VITE_TOKEN_DISCOVERY_ENABLED: "true",
      VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"AB".repeat(32)}`,
      VITE_STANDARD_TOKEN_HASH: "CD".repeat(32),
      TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "https://private-registry.test",
    };
    const manifest = createPublicConfigManifest(enabled);
    expect(manifest.VITE_STANDARD_TOKEN_HASH).toBe(`0x${"cd".repeat(32)}`);
    expect(parsePublicConfigManifest(JSON.stringify(manifest))).toEqual(
      manifest,
    );
    expect(JSON.stringify(manifest)).not.toContain("private-registry");
    const { VITE_TOKEN_DISCOVERY_ENABLED: _flag, ...old } = manifest;
    expect(() => parsePublicConfigManifest(JSON.stringify(old))).toThrow(
      /unexpected fields/,
    );
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({
          ...manifest,
          VITE_STANDARD_TOKEN_HASH: "CD".repeat(32),
        }),
      ),
    ).toThrow(/canonical/);
    directory = await mkdtemp(path.join(os.tmpdir(), "swap-manifest-"));
    const file = path.join(directory, "manifest.json");
    await writeFile(file, JSON.stringify(manifest));
    await expect(
      verifyPublicConfigManifest(file, {
        ...enabled,
        VITE_STANDARD_TOKEN_HASH: manifest.VITE_STANDARD_TOKEN_HASH,
        TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "https://other-private-registry.test",
      }),
    ).resolves.toEqual(manifest);
    for (const change of [
      { VITE_TOKEN_DISCOVERY_ENABLED: "false" },
      { VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"12".repeat(32)}` },
      { VITE_STANDARD_TOKEN_HASH: `0x${"34".repeat(32)}` },
    ]) {
      await expect(
        verifyPublicConfigManifest(file, { ...enabled, ...change }),
      ).rejects.toThrow(/does not match/);
    }
  });
});
