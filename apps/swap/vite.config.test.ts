// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  developmentPrivateKeyDefinition,
  isAllowedRequest,
  isSameOriginLocalRequest,
  validateRpcTarget,
} from "./vite.config";

describe("development private key boundary", () => {
  const canary = `0x${"a5".repeat(32)}`;

  it("does not define the private key for builds", () => {
    expect(
      developmentPrivateKeyDefinition(
        "build",
        false,
        "http://127.0.0.1:9545",
        { GROUNDHOG_DEV_PRIVATE_KEY: canary },
      ),
    ).toBe("undefined");
  });

  it("defines the private key only while serving locally", () => {
    expect(
      developmentPrivateKeyDefinition(
        "serve",
        false,
        "http://127.0.0.1:9545",
        { GROUNDHOG_DEV_PRIVATE_KEY: canary },
      ),
    ).toBe(JSON.stringify(canary));
    expect(
      developmentPrivateKeyDefinition(
        "serve",
        false,
        "http://127.0.0.1:9545",
        {},
      ),
    ).toBe("undefined");
  });

  it("does not define the key for preview or a remote RPC target", () => {
    const environment = { GROUNDHOG_DEV_PRIVATE_KEY: canary };

    expect(
      developmentPrivateKeyDefinition(
        "serve",
        true,
        "http://127.0.0.1:9545",
        environment,
      ),
    ).toBe("undefined");
    expect(
      developmentPrivateKeyDefinition(
        "serve",
        false,
        "https://rpc.example.com",
        environment,
      ),
    ).toBe("undefined");
  });
});

describe("local RPC proxy policy", () => {
  it.each([
    "groundhog_chainTip",
    "groundhog_getEvents",
    "groundhog_getBlockByNumber",
    "groundhog_view",
    "groundhog_sendRawTransaction",
    "groundhog_getTransactionStatus",
    "groundhog_getTransactionReceipt",
  ])("allows %s", (method) => {
    expect(isAllowedRequest({ jsonrpc: "2.0", id: 1, method })).toBe(true);
  });

  it("rejects unrelated RPC methods and batches", () => {
    expect(isAllowedRequest({ method: "groundhog_deleteAllData" })).toBe(false);
    expect(isAllowedRequest([{ method: "groundhog_view" }])).toBe(false);
  });

  it("requires a loopback host and rejects cross-site requests", () => {
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
    expect(
      isSameOriginLocalRequest({ headers: { host: "localhost:5173" } }),
    ).toBe(false);
    expect(
      isSameOriginLocalRequest({
        headers: {
          host: "localhost:5173",
          origin: "https://localhost:5173",
        },
      }),
    ).toBe(false);
  });

  it("rejects credential-bearing RPC targets before Vite serves the app", () => {
    expect(() =>
      validateRpcTarget("http://operator:secret@127.0.0.1:9545"),
    ).toThrow("must not contain credentials");
  });
});
