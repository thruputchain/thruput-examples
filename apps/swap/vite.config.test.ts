// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  isAllowedRequest,
  isSameOriginLocalRequest,
} from "./vite.config";

describe("local RPC proxy policy", () => {
  it.each([
    "groundhog_chainTip",
    "groundhog_view",
    "groundhog_sendRawTransaction",
    "groundhog_getTransactionStatus",
    "groundhog_getTransactionReceipt",
  ])("allows %s", (method) => {
    expect(isAllowedRequest({ jsonrpc: "2.0", id: 1, method })).toBe(true);
  });

  it("rejects unrelated RPC methods and batches", () => {
    expect(isAllowedRequest({ method: "groundhog_getEvents" })).toBe(false);
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
  });
});
