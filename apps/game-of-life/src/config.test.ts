import { describe, expect, test } from "vitest";
import { ConfigurationError, loadAppConfig } from "./config";

const valid = {
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
  VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
  VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: `0x${"bb".repeat(32)}`,
  VITE_GAME_OF_LIFE_INDEXER_URL: "http://localhost:8787/",
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
});
