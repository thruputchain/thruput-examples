// @vitest-environment node
import { toBase58 } from "@thruputchain/client";

import { describe, expect, it } from "vitest";

import { loadServerConfig, ServerConfigurationError } from "./config.ts";

const environment = {
  PORT: "3000",
  TOKEN_REGISTRY_DB_PATH: "/data/registry.sqlite",
  VITE_THRUPUT_RPC_URL: "https://rpc.example.test/path",
  VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0xaa)),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: toBase58(new Uint8Array(32).fill(0xbb)),
  VITE_STANDARD_TOKEN_HASH: toBase58(new Uint8Array(32).fill(0xcc)),
};

describe("loadServerConfig", () => {
  it("parses the complete server configuration", () => {
    const config = loadServerConfig(environment);

    expect(config).toMatchObject({
      port: 3000,
      databasePath: "/data/registry.sqlite",
      syncIntervalMs: 5_000,
      pageSize: 200,
      scope: {
        networkId: toBase58(new Uint8Array(32).fill(0xaa)),
        factoryAddress: toBase58(new Uint8Array(32).fill(0xbb)),
        tokenCodeHash: toBase58(new Uint8Array(32).fill(0xcc)),
      },
    });
    expect(config.rpcUrl.href).toBe("https://rpc.example.test/path");
  });

  it("accepts bounded optional values", () => {
    const config = loadServerConfig({
      ...environment,
      TOKEN_REGISTRY_SYNC_INTERVAL_MS: "1000",
      TOKEN_REGISTRY_PAGE_SIZE: "500",
      PORT: "65535",
    });
    expect(config.syncIntervalMs).toBe(1_000);
    expect(config.pageSize).toBe(500);
    expect(config.port).toBe(65_535);
  });

  it("accepts credential-free remote HTTP for the documented devnet", () => {
    const config = loadServerConfig({
      ...environment,
      VITE_THRUPUT_RPC_URL: "http://devnet.example.test/rpc",
    });
    expect(config.rpcUrl.href).toBe("http://devnet.example.test/rpc");
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "1.5"],
    ["TOKEN_REGISTRY_SYNC_INTERVAL_MS", "999"],
    ["TOKEN_REGISTRY_PAGE_SIZE", "501"],
    ["VITE_THRUPUT_NETWORK_ID", "abc"],
    // Public identifiers must use base58.
    ["VITE_STANDARD_TOKEN_FACTORY_ADDRESS", `0x${"11".repeat(32)}`],
    ["VITE_STANDARD_TOKEN_HASH", "zz".repeat(32)],
    ["VITE_THRUPUT_RPC_URL", "ftp://rpc.example.test"],
    ["VITE_THRUPUT_RPC_URL", "https://user:secret@rpc.example.test"],
    ["VITE_THRUPUT_RPC_URL", "https://rpc.example.test?token=secret"],
    ["VITE_THRUPUT_RPC_URL", "https://rpc.example.test#secret"],
  ])("rejects invalid %s", (key, value) => {
    expect(() => loadServerConfig({ ...environment, [key]: value })).toThrow(
      ServerConfigurationError,
    );
  });

  it("rejects missing required values", () => {
    expect(() => loadServerConfig({ ...environment, PORT: undefined })).toThrow(
      /PORT is required/,
    );
  });
});
