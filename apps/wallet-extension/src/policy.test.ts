import { describe, expect, it } from "vitest";
import {
  canSubmit,
  pageOrigin,
  requestSchema,
  MAX_UNSIGNED_BYTES,
} from "./policy";
const account = `0x${"11".repeat(32)}`,
  networkHash = "00".repeat(32);
describe("page trust boundary", () => {
  const sender = {
    frameId: 0,
    tab: { id: 1 },
    documentId: "document",
    url: "https://app.example/path",
    origin: "https://app.example",
  } as chrome.runtime.MessageSender;
  it("uses browser sender identity, not page-provided origin", () => {
    expect(pageOrigin(sender)).toBe("https://app.example");
    for (const bad of [
      { frameId: 1 },
      { origin: "null" },
      { documentId: undefined },
      { url: "https://other.example" },
      { url: "file:///index.html", origin: "null" },
    ])
      expect(() => pageOrigin({ ...sender, ...bad })).toThrow();
  });
  it("rejects privileged dispatch, extra fields, noncanonical and oversized XDR", () => {
    expect(requestSchema({ method: "connect" })).toEqual({ method: "connect" });
    expect(() => requestSchema({ method: "export" })).toThrow();
    expect(() =>
      requestSchema({ method: "connect", origin: "https://trusted.example" }),
    ).toThrow();
    for (const transaction of [
      "ab",
      "0xAABB",
      "0xabc",
      `0x${"aa".repeat(MAX_UNSIGNED_BYTES + 1)}`,
    ])
      expect(() =>
        requestSchema({
          method: "signTransaction",
          params: { account, networkHash, transaction },
        }),
      ).toThrow();
  });
  it("requires identical durable bytes and matching origin, account, network, lock and grant", () => {
    const candidate = {
      origin: "https://app.example",
      account,
      networkHash,
      signedTransaction: "0xaabb",
    };
    const approval = { ...candidate, hash: "0x1234" };
    expect(canSubmit(structuredClone(approval), candidate, true, true)).toBe(
      true,
    );
    for (const change of [
      { origin: "https://evil.example" },
      { account: "other" },
      { networkHash: "ff".repeat(32) },
      { signedTransaction: "0xaabc" },
    ])
      expect(canSubmit(approval, { ...candidate, ...change }, true, true)).toBe(
        false,
      );
    expect(canSubmit(approval, candidate, false, true)).toBe(false);
    expect(canSubmit(approval, candidate, true, false)).toBe(false);
    expect(canSubmit(undefined, candidate, true, true)).toBe(false);
  });
});
