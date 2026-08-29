import { describe, expect, test } from "vitest";
import { ConfigurationError, loadAppConfig } from "./config";

const valid = {
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
  VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"bb".repeat(32)}`,
  VITE_GAME_OF_LIFE_INDEXER_URL: "http://localhost:8787/",
};
const profiles = {
  VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "100000",
  VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "100000",
  VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
  VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
  VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: "10010000000",
  VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000000",
  VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "2",
  VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
};
describe("startup configuration", () => {
  test("normalizes only the network ID and freezes the result", () => {
    const config = loadAppConfig(valid);
    expect(config.networkId).toBe("aa".repeat(32));
    expect(config.contractAddress).toBe(`0x${"bb".repeat(32)}`);
    expect(Object.isFrozen(config)).toBe(true);
  });
  test.each(["file:///tmp/rpc", "http://user:pass@localhost:1"])(
    "rejects unsafe URL %s",
    (url) =>
      expect(() =>
        loadAppConfig({ ...valid, VITE_GROUNDHOG_RPC_URL: url }),
      ).toThrow(ConfigurationError),
  );
  test("requires canonical lowercase contract addresses", () =>
    expect(() =>
      loadAppConfig({
        ...valid,
        VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"BB".repeat(32)}`,
      }),
    ).toThrow(/canonical lowercase/));
  test.each([
    "http://localhost:8787/root/",
    "http://localhost:8787/?world=life",
    "http://localhost:8787/#life",
  ])("rejects non-root indexer URL %s", (url) =>
    expect(() =>
      loadAppConfig({ ...valid, VITE_GAME_OF_LIFE_INDEXER_URL: url }),
    ).toThrow(/origin root/),
  );
  test("requires every Phase 4 public value", () =>
    expect(() =>
      loadAppConfig({ ...valid, VITE_GAME_OF_LIFE_INDEXER_URL: undefined }),
    ).toThrow(/required/));
  test("loads separate measured transaction profiles", () => {
    const config = loadAppConfig({ ...valid, ...profiles });
    expect(config.transactionProfiles).toEqual({
      request: {
        transactionGasLimit: 100_000n,
        targetGasLimit: 100_000n,
        expiryBlocks: 64n,
        observationTimeoutMs: 30_000,
      },
      crank: {
        transactionGasLimit: 10_010_000_000n,
        targetGasLimit: 10_000_000_000n,
        expiryBlocks: 2n,
        observationTimeoutMs: 300_000,
      },
    });
  });
  test("keeps the read-only application valid when profiles are absent", () =>
    expect(loadAppConfig(valid).transactionProfiles).toBeNull());
  test("rejects partial and placeholder crank profiles", () => {
    expect(() =>
      loadAppConfig({
        ...valid,
        VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "100000",
      }),
    ).toThrow(/required together/);
    expect(() =>
      loadAppConfig({
        ...valid,
        ...profiles,
        VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000",
      }),
    ).toThrow(/placeholder/);
  });
});
