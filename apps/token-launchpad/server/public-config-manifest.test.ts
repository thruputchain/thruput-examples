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
  VITE_GROUNDHOG_NETWORK_ID: "11".repeat(32),
  VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
  VITE_NATIVE_BALANCE_ITEM_COST: "1234",
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"55".repeat(32)}`,
  VITE_STANDARD_TOKEN_HASH: `0x${"66".repeat(32)}`,
  VITE_TOKEN_REGISTRY_ENABLED: "true",
};
const manifest = {
  VITE_EXPLORER_URL: "",
  VITE_SWAP_APP_URL: "",
  VITE_GROUNDHOG_RPC_URL_SHA256: createHash("sha256")
    .update(rpcUrl)
    .digest("hex"),
  VITE_GROUNDHOG_NETWORK_ID: environment.VITE_GROUNDHOG_NETWORK_ID,
  VITE_NATIVE_HOG_ADDRESS: environment.VITE_NATIVE_HOG_ADDRESS,
  VITE_NATIVE_BALANCE_ITEM_COST: environment.VITE_NATIVE_BALANCE_ITEM_COST,
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS:
    environment.VITE_STANDARD_TOKEN_FACTORY_ADDRESS,
  VITE_STANDARD_TOKEN_HASH: environment.VITE_STANDARD_TOKEN_HASH,
  VITE_TOKEN_REGISTRY_ENABLED: environment.VITE_TOKEN_REGISTRY_ENABLED,
};

describe("production public configuration manifest", () => {
  let directory: string | undefined;

  it("normalizes explorer config, enforces its exact schema, and rejects runtime drift", async () => {
    const configured = createPublicConfigManifest({
      ...environment,
      VITE_EXPLORER_URL: "https://EXPLORER.example.test:443/",
    });
    expect(configured.VITE_EXPLORER_URL).toBe("https://explorer.example.test");
    expect(
      createPublicConfigManifest({ ...environment, VITE_EXPLORER_URL: " " })
        .VITE_EXPLORER_URL,
    ).toBe("");
    const { VITE_EXPLORER_URL: _url, ...old } = manifest;
    expect(() => parsePublicConfigManifest(JSON.stringify(old))).toThrow(
      /unexpected fields/,
    );
    for (const value of [
      "https://explorer.example.test/",
      "http://remote.test",
      "https://example.test/path",
      false,
    ]) {
      expect(() =>
        parsePublicConfigManifest(
          JSON.stringify({ ...manifest, VITE_EXPLORER_URL: value }),
        ),
      ).toThrow(/VITE_EXPLORER_URL/);
    }
    directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-manifest-"));
    const file = path.join(directory, "manifest.json");
    await writeFile(file, JSON.stringify(configured));
    await expect(
      verifyPublicConfigManifest(file, {
        ...environment,
        VITE_EXPLORER_URL: "https://explorer.example.test/",
      }),
    ).resolves.toEqual(configured);
    await expect(verifyPublicConfigManifest(file, environment)).rejects.toThrow(
      /VITE_EXPLORER_URL does not match/,
    );
  });

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("contains validated public values and only a digest of the RPC URL", () => {
    const created = createPublicConfigManifest({
      ...environment,
      PRIVATE_VALUE: "secret",
    });
    expect(created).toEqual(manifest);
    expect(created).not.toHaveProperty("PRIVATE_VALUE");
    expect(created).not.toHaveProperty("VITE_GROUNDHOG_RPC_URL");
    expect(JSON.stringify(created)).not.toContain(rpcUrl);
  });

  it.each([
    ["VITE_GROUNDHOG_RPC_URL", "not-a-url"],
    ["VITE_GROUNDHOG_RPC_URL", "ftp://rpc.example.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://user:secret@rpc.example.test"],
    ["VITE_GROUNDHOG_RPC_URL", "https://rpc.example.test/?token=secret"],
    ["VITE_GROUNDHOG_RPC_URL", "https://rpc.example.test/#secret"],
    ["VITE_GROUNDHOG_NETWORK_ID", "11".repeat(31)],
    ["VITE_NATIVE_HOG_ADDRESS", `0x${"gg".repeat(32)}`],
    ["VITE_STANDARD_TOKEN_FACTORY_ADDRESS", `0x${"55".repeat(31)}`],
    ["VITE_NATIVE_BALANCE_ITEM_COST", "01234"],
    ["VITE_NATIVE_BALANCE_ITEM_COST", "1235"],
    ["VITE_STANDARD_TOKEN_HASH", "66".repeat(32)],
  ])("rejects invalid %s", (key, value) => {
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

  it("strictly rejects malformed, extended, and semantically invalid manifests", () => {
    expect(() => parsePublicConfigManifest("[]")).toThrow(
      PublicConfigManifestError,
    );
    expect(() =>
      parsePublicConfigManifest(JSON.stringify({ ...manifest, extra: "x" })),
    ).toThrow(/unexpected fields/);
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({
          ...manifest,
          VITE_GROUNDHOG_RPC_URL_SHA256: "not-a-digest",
        }),
      ),
    ).toThrow(/VITE_GROUNDHOG_RPC_URL_SHA256/);
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({ ...manifest, VITE_NATIVE_BALANCE_ITEM_COST: 1234 }),
      ),
    ).toThrow(/VITE_NATIVE_BALANCE_ITEM_COST/);
  });

  it("requires exact runtime equality without exposing values", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-manifest-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const secretRpcUrl = "https://distinctive-secret.example.test/groundhog";
    await expect(
      verifyPublicConfigManifest(manifestPath, {
        ...environment,
        VITE_GROUNDHOG_RPC_URL: secretRpcUrl,
      }),
    ).rejects.toThrow(/VITE_GROUNDHOG_RPC_URL does not match/);
    await expect(
      verifyPublicConfigManifest(manifestPath, {
        ...environment,
        VITE_GROUNDHOG_RPC_URL: secretRpcUrl,
      }),
    ).rejects.not.toThrow(/distinctive-secret/);
    await expect(
      verifyPublicConfigManifest(manifestPath, environment),
    ).resolves.toEqual(manifest);
  });

  it("checks every infrastructure field while ignoring obsolete wallet environment values", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-manifest-"));
    const file = path.join(directory, "manifest.json");
    await writeFile(file, JSON.stringify(manifest));
    await expect(
      verifyPublicConfigManifest(file, {
        ...environment,
        VITE_GROUNDHOG_WALLET_ADDRESS: "not browser configuration",
        VITE_GROUNDHOG_WALLET_ENTRYPOINT: "not browser configuration",
      }),
    ).resolves.toEqual(manifest);
    for (const key of [
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_NATIVE_HOG_ADDRESS",
      "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
      "VITE_STANDARD_TOKEN_HASH",
    ] as const) {
      const value =
        key === "VITE_GROUNDHOG_NETWORK_ID"
          ? "aa".repeat(32)
          : `0x${"aa".repeat(32)}`;
      await expect(
        verifyPublicConfigManifest(file, { ...environment, [key]: value }),
      ).rejects.toThrow(`${key} does not match`);
    }
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({
          ...manifest,
          VITE_GROUNDHOG_WALLET_ADDRESS: "old schema",
        }),
      ),
    ).toThrow(/unexpected fields/);
  });

  it("normalizes the optional Swap origin and rejects drift and the old schema", async () => {
    const configured = createPublicConfigManifest({
      ...environment,
      VITE_SWAP_APP_URL: "https://SWAP.example.test:443/",
    });
    expect(configured.VITE_SWAP_APP_URL).toBe("https://swap.example.test");
    expect(parsePublicConfigManifest(JSON.stringify(configured))).toEqual(
      configured,
    );
    expect(
      createPublicConfigManifest({ ...environment, VITE_SWAP_APP_URL: "  " })
        .VITE_SWAP_APP_URL,
    ).toBe("");
    const { VITE_SWAP_APP_URL: _url, ...old } = manifest;
    expect(() => parsePublicConfigManifest(JSON.stringify(old))).toThrow(
      /unexpected fields/,
    );
    expect(() =>
      parsePublicConfigManifest(
        JSON.stringify({
          ...configured,
          VITE_SWAP_APP_URL: "https://swap.example.test/",
        }),
      ),
    ).toThrow(/canonical/);
    directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-manifest-"));
    const file = path.join(directory, "manifest.json");
    await writeFile(file, JSON.stringify(configured));
    await expect(
      verifyPublicConfigManifest(file, {
        ...environment,
        VITE_SWAP_APP_URL: "https://swap.example.test/",
      }),
    ).resolves.toEqual(configured);
    await expect(verifyPublicConfigManifest(file, environment)).rejects.toThrow(
      /VITE_SWAP_APP_URL does not match/,
    );
  });
});
