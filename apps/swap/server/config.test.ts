// @vitest-environment node

import { toBase58 } from "@thruputchain/client";
import { describe, expect, it } from "vitest";

import { loadServerConfig, ServerConfigurationError } from "./config.ts";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

const environment = {
  PORT: "3000",
  POOL_REGISTRY_DB_PATH: "/data/pools.sqlite",
  VITE_THRUPUT_RPC_URL: "https://rpc.example.test/path",
  VITE_THRUPUT_NETWORK_ID: b58(0xaa),
  VITE_SWAP_FACTORY_ADDRESS: b58(0xbb),
};

describe("loadServerConfig", () => {
  it("parses and canonicalizes the complete server configuration", () => {
    const config = loadServerConfig(environment);

    expect(config).toMatchObject({
      port: 3000,
      databasePath: "/data/pools.sqlite",
      syncIntervalMs: 5_000,
      pageSize: 200,
      scope: {
        networkId: "aa".repeat(32),
        factoryAddress: `0x${"bb".repeat(32)}`,
      },
    });
    expect(config.rpcUrl.href).toBe("https://rpc.example.test/path");
  });

  it("accepts bounded optional values and remote HTTP", () => {
    const config = loadServerConfig({
      ...environment,
      PORT: "65535",
      POOL_REGISTRY_SYNC_INTERVAL_MS: "1000",
      POOL_REGISTRY_PAGE_SIZE: "500",
      VITE_THRUPUT_RPC_URL: "http://devnet.example.test/rpc",
    });
    expect(config.port).toBe(65_535);
    expect(config.syncIntervalMs).toBe(1_000);
    expect(config.pageSize).toBe(500);
    expect(config.rpcUrl.href).toBe("http://devnet.example.test/rpc");
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "1.5"],
    ["POOL_REGISTRY_SYNC_INTERVAL_MS", "999"],
    ["POOL_REGISTRY_PAGE_SIZE", "501"],
    ["VITE_THRUPUT_NETWORK_ID", "abc"],
    ["VITE_SWAP_FACTORY_ADDRESS", "11".repeat(32)],
    ["VITE_THRUPUT_RPC_URL", "ftp://rpc.example.test"],
    ["VITE_THRUPUT_RPC_URL", "https://user:secret@rpc.example.test"],
    ["VITE_THRUPUT_RPC_URL", "https://rpc.example.test?token=secret"],
    ["VITE_THRUPUT_RPC_URL", "https://rpc.example.test#secret"],
    ["POOL_REGISTRY_DB_PATH", "/data/"],
    ["POOL_REGISTRY_DB_PATH", ":memory:"],
    ["POOL_REGISTRY_DB_PATH", "bad\0path"],
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
