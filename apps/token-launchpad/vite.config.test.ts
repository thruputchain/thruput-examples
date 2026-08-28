// @vitest-environment node

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  developmentPersonasDefinition,
  isAllowedRequest,
  isSameOriginLocalRequest,
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

  it("accepts only credential-free loopback HTTP targets", () => {
    expect(() => validateRpcTarget("http://127.0.0.1:9545")).not.toThrow();
    expect(() =>
      validateRpcTarget("http://operator:secret@127.0.0.1:9545"),
    ).toThrow(/credentials/);
    expect(() => validateRpcTarget("http://rpc.example.com")).toThrow(
      /loopback HTTP/,
    );
    expect(() => validateRpcTarget("https://localhost:9545")).toThrow(
      /loopback HTTP/,
    );
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
