// @vitest-environment node

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  developmentPersonasDefinition,
  isAllowedRequest,
  isSameOriginLocalRequest,
  PRODUCTION_BROWSER_RPC_URL,
  productionPublicConfigManifest,
  readBody,
  readUpstreamBody,
  validateDevelopmentServerHost,
  validateRpcTarget,
} from "./vite.config";

describe("development credential boundary", () => {
  const personas = `[{"id":"alice","privateKey":"0x${"a5".repeat(32)}"}]`;

  it("injects personas only for loopback development serve", () => {
    expect(
      developmentPersonasDefinition(
        "serve",
        false,
        { GROUNDHOG_DEV_PERSONAS: personas },
        "http://127.0.0.1:9545",
      ),
    ).toBe(JSON.stringify(personas));
    expect(
      developmentPersonasDefinition(
        "build",
        false,
        { GROUNDHOG_DEV_PERSONAS: personas },
        "http://127.0.0.1:9545",
      ),
    ).toBe("undefined");
    expect(
      developmentPersonasDefinition(
        "serve",
        true,
        { GROUNDHOG_DEV_PERSONAS: personas },
        "http://127.0.0.1:9545",
      ),
    ).toBe("undefined");
  });

  it("rejects exposing credentials from a network host", () => {
    expect(() => validateDevelopmentServerHost("0.0.0.0", true)).toThrow(
      /loopback host/,
    );
    expect(() => validateDevelopmentServerHost(true, true)).toThrow(
      /loopback host/,
    );
    expect(() =>
      validateDevelopmentServerHost("127.0.0.1", true),
    ).not.toThrow();
    expect(() => validateDevelopmentServerHost("::1", true)).not.toThrow();
  });
});

describe("local RPC proxy policy", () => {
  it.each([
    "groundhog_networkInfo",
    "groundhog_chainTip",
    "groundhog_getEvents",
    "groundhog_view",
    "groundhog_sendRawTransaction",
    "groundhog_getTransactionStatus",
    "groundhog_getTransactionReceipt",
  ])("allows %s", (method) => {
    expect(isAllowedRequest({ jsonrpc: "2.0", id: 1, method })).toBe(true);
  });

  it("rejects unrelated methods and batches", () => {
    expect(isAllowedRequest({ method: "groundhog_deleteAllData" })).toBe(false);
    expect(isAllowedRequest([{ method: "groundhog_view" }])).toBe(false);
  });

  it("requires a same-origin loopback request", () => {
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "http://localhost:5173",
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toBe(true);
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    ).toBe(false);
    expect(
      isSameOriginLocalRequest({ headers: { host: "192.168.1.10:5173" } }),
    ).toBe(false);
  });

  it("keeps serve and preview RPC targets on loopback HTTP", () => {
    const serve = {
      command: "serve" as const,
      isPreview: false,
      registryEnabled: true,
    };
    const preview = { ...serve, isPreview: true };
    expect(() =>
      validateRpcTarget("http://127.0.0.1:9545", serve),
    ).not.toThrow();
    expect(() =>
      validateRpcTarget("http://localhost:9545", preview),
    ).not.toThrow();
    expect(() =>
      validateRpcTarget("http://operator:secret@127.0.0.1:9545", serve),
    ).toThrow(/credentials/);
    expect(() => validateRpcTarget("http://rpc.example.com", serve)).toThrow(
      /loopback HTTP/,
    );
    expect(() => validateRpcTarget("https://localhost:9545", preview)).toThrow(
      /loopback HTTP/,
    );
  });

  it("allows remote HTTP or HTTPS only for registry-enabled production builds", () => {
    const enabledBuild = {
      command: "build" as const,
      isPreview: false,
      registryEnabled: true,
    };
    expect(() =>
      validateRpcTarget("http://devnet.example.com/rpc", enabledBuild),
    ).not.toThrow();
    expect(() =>
      validateRpcTarget("https://devnet.example.com/rpc", enabledBuild),
    ).not.toThrow();
    expect(() =>
      validateRpcTarget("https://user:secret@devnet.example.com", enabledBuild),
    ).toThrow(/credentials/);
    expect(() =>
      validateRpcTarget(
        "https://devnet.example.com/rpc?token=secret",
        enabledBuild,
      ),
    ).toThrow(/query string or fragment/);
    expect(() =>
      validateRpcTarget("https://devnet.example.com/rpc#secret", enabledBuild),
    ).toThrow(/query string or fragment/);
    expect(() =>
      validateRpcTarget("ftp://devnet.example.com", enabledBuild),
    ).toThrow(/loopback HTTP/);

    expect(() =>
      validateRpcTarget("http://devnet.example.com", {
        ...enabledBuild,
        registryEnabled: false,
      }),
    ).toThrow(/loopback HTTP/);
  });

  it("bounds request and upstream response bodies", async () => {
    await expect(
      readBody(
        Readable.from([Buffer.alloc(1_000_001)]) as unknown as Parameters<
          typeof readBody
        >[0],
      ),
    ).rejects.toThrow(/too large/);
    await expect(
      readUpstreamBody(
        new Response("{}", { headers: { "content-length": "1000001" } }),
      ),
    ).rejects.toThrow(/too large/);
    await expect(
      readUpstreamBody(new Response(new Uint8Array(1_000_001))),
    ).rejects.toThrow(/too large/);
  });
});

describe("production public configuration plugin", () => {
  const environment = {
    VITE_GROUNDHOG_RPC_URL: "https://rpc.example.test",
    VITE_GROUNDHOG_NETWORK_ID: "11".repeat(32),
    VITE_GROUNDHOG_WALLET_ADDRESS: `0x${"22".repeat(32)}`,
    VITE_GROUNDHOG_WALLET_ENTRYPOINT: `0x${"33".repeat(8)}`,
    VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
    VITE_NATIVE_BALANCE_ITEM_COST: "1234",
    VITE_STANDARD_TOKEN_FACTORY_ADDRESS: `0x${"55".repeat(32)}`,
    VITE_STANDARD_TOKEN_HASH: `0x${"66".repeat(32)}`,
    VITE_TOKEN_REGISTRY_ENABLED: "true",
  };

  it("is created only from complete registry-enabled configuration", () => {
    expect(productionPublicConfigManifest(environment).name).toBe(
      "groundhog-production-public-config-manifest",
    );
    expect(() =>
      productionPublicConfigManifest({
        ...environment,
        VITE_GROUNDHOG_WALLET_ENTRYPOINT: "",
      }),
    ).toThrow(/VITE_GROUNDHOG_WALLET_ENTRYPOINT is required/);
    expect(() =>
      productionPublicConfigManifest({
        ...environment,
        VITE_TOKEN_REGISTRY_ENABLED: "TRUE",
      }),
    ).toThrow(/must be exactly true/);
  });

  it("uses a benign URL that the registry-enabled browser client replaces with its origin", () => {
    expect(PRODUCTION_BROWSER_RPC_URL).toBe("https://same-origin.invalid/");
  });
});
