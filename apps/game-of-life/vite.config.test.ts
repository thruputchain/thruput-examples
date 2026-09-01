// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  allowedIndexerRoute,
  developmentPersonaDefinition,
  isIndexerArtifactNotFound,
  isAllowedRpcRequest,
  isSameOriginLoopback,
  isSafeCredentialRequest,
  indexerProxyScope,
  validateIndexerTarget,
  validateCredentialServerHost,
  validateRpcTarget,
} from "./vite.config";
const network = "11".repeat(32);
const contract = `0x${"22".repeat(32)}`;
describe("read-only RPC proxy policy", () => {
  test.each(["groundhog_chainTip", "groundhog_getEvents", "groundhog_view"])(
    "allows %s",
    (method) =>
      expect(
        isAllowedRpcRequest({ jsonrpc: "2.0", id: 1, method, params: {} }),
      ).toBe(true),
  );
  test.each([
    "groundhog_sendRawTransaction",
    "groundhog_getTransactionReceipt",
    "eth_call",
  ])("denies %s", (method) =>
    expect(isAllowedRpcRequest({ jsonrpc: "2.0", id: 1, method })).toBe(false),
  );
  test("allows write RPC methods only for credential-enabled development", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "groundhog_sendRawTransaction",
      params: ["signed"],
    };
    expect(isAllowedRpcRequest(request)).toBe(false);
    expect(isAllowedRpcRequest(request, true)).toBe(true);
  });
  test("rejects batches, notifications, and unknown envelope fields", () => {
    expect(isAllowedRpcRequest([])).toBe(false);
    expect(
      isAllowedRpcRequest({ jsonrpc: "2.0", method: "groundhog_view" }),
    ).toBe(false);
    expect(
      isAllowedRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_view",
        extra: true,
      }),
    ).toBe(false);
  });
  test("requires matching same-origin loopback headers", () => {
    expect(
      isSameOriginLoopback({
        host: "127.0.0.1:4176",
        origin: "http://127.0.0.1:4176",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
    expect(
      isSameOriginLoopback({
        host: "127.0.0.1:4176",
        origin: "http://evil.test",
      }),
    ).toBe(false);
    expect(
      isSameOriginLoopback({
        host: "localhost:4176",
        referer: "http://localhost:4176/explorer",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
  });
  test.each([
    "https://rpc.example.test",
    "file:///rpc",
    "http://user:pass@127.0.0.1",
  ])("rejects unsafe target %s", (target) =>
    expect(() => validateRpcTarget(target)).toThrow(/loopback/),
  );
});

describe("development credential boundary", () => {
  const profileEnvironment = {
    VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT: "100000",
    VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT: "100000",
    VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS: "64",
    VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS: "30000",
    VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT: "10010000000",
    VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT: "10000000000",
    VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS: "2",
    VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS: "300000",
  };
  test("injects credentials only for serve with complete profiles", () => {
    const environment = {
      ...profileEnvironment,
      GROUNDHOG_DEV_PERSONAS: "[]",
    };
    expect(developmentPersonaDefinition("serve", environment)).toBe("[]");
    expect(developmentPersonaDefinition("build", environment)).toBeUndefined();
    expect(() =>
      developmentPersonaDefinition("serve", {
        GROUNDHOG_DEV_PERSONAS: "[]",
      }),
    ).toThrow(/complete transaction profiles/);
  });
  test("accepts only loopback credential-bearing document requests", () => {
    expect(
      isSafeCredentialRequest({ host: "127.0.0.1:4176" }, "127.0.0.1"),
    ).toBe(true);
    expect(
      isSafeCredentialRequest(
        {
          host: "localhost:4176",
          origin: "http://localhost:4176",
          "sec-fetch-site": "same-origin",
        },
        "::1",
      ),
    ).toBe(true);
    expect(
      isSafeCredentialRequest({ host: "example.test:4176" }, "127.0.0.1"),
    ).toBe(false);
    expect(
      isSafeCredentialRequest(
        {
          host: "127.0.0.1:4176",
          origin: "http://evil.test",
        },
        "127.0.0.1",
      ),
    ).toBe(false);
    expect(
      isSafeCredentialRequest({ host: "127.0.0.1:4176" }, "192.168.1.9"),
    ).toBe(false);
  });
  test("rejects a CLI override to an external listen address", () => {
    expect(() => validateCredentialServerHost("0.0.0.0")).toThrow(/loopback/);
    expect(() => validateCredentialServerHost(true)).toThrow(/loopback/);
    expect(() => validateCredentialServerHost("127.0.0.1")).not.toThrow();
  });
});

describe("read-only indexer proxy policy", () => {
  test("preserves only an upstream not-found status", () => {
    expect(isIndexerArtifactNotFound(404)).toBe(true);
    expect(isIndexerArtifactNotFound(400)).toBe(false);
    expect(isIndexerArtifactNotFound(500)).toBe(false);
  });
  test("normalizes optional-0x uppercase network env before routing", () => {
    const scope = indexerProxyScope({
      VITE_GROUNDHOG_NETWORK_ID: `0x${"AA".repeat(32)}`,
      VITE_GAME_OF_LIFE_CONTRACT_ADDRESS: contract,
    });
    expect(scope.networkId).toBe("aa".repeat(32));
    expect(
      allowedIndexerRoute(
        `/v1/worlds/${"aa".repeat(32)}/${contract}/latest.json`,
        scope.networkId,
        scope.contractAddress,
      ),
    ).not.toBeNull();
  });
  test.each([
    `/v1/worlds/${network}/${contract}/latest.json`,
    `/v1/worlds/${network}/${contract}/status.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/manifest.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/provenance.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/tiles/6/39/39.bin`,
  ])("allows configured artifact %s", (path) =>
    expect(allowedIndexerRoute(path, network, contract)).not.toBeNull(),
  );

  test.each([
    `/v1/worlds/${network}/${contract}/latest.json?redirect=x`,
    `/v1/worlds/${network}/${contract}/../status.json`,
    `/v1/worlds/${network}/${contract}/0x${"aa".repeat(32)}/tiles/6/40/0.bin`,
    `/v1/worlds/${"33".repeat(32)}/${contract}/latest.json`,
  ])("rejects non-canonical artifact %s", (path) =>
    expect(allowedIndexerRoute(path, network, contract)).toBeNull(),
  );

  test("rejects non-loopback upstreams", () =>
    expect(() => validateIndexerTarget("https://indexer.example.test")).toThrow(
      /loopback/,
    ));
  test.each([
    "http://127.0.0.1:8787/root/",
    "http://127.0.0.1:8787/?world=life",
    "http://127.0.0.1:8787/#life",
  ])("rejects non-root upstream %s", (target) =>
    expect(() => validateIndexerTarget(target)).toThrow(/origin root/),
  );
});
