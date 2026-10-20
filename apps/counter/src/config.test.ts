import { describe, expect, it } from "vitest";
import { toBase58 } from "@thruputchain/client";
import { parseConfig } from "./config";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const valid = {
  networkId: b58(0x00),
  counterAddress: b58(0x11),
  signerAddress: b58(0x22),
};
describe("configuration", () => {
  it("accepts base58 network, contract, and signer identifiers", () => {
    expect(parseConfig(valid)).toMatchObject({
      ...valid,
      explorerUrl: null,
    });
  });
  it.each(["networkId", "counterAddress", "signerAddress"])(
    "rejects hex %s from older setups",
    (field) => {
      expect(() =>
        parseConfig({ ...valid, [field]: `0x${"11".repeat(32)}` }),
      ).toThrow();
    },
  );
  it.each(["networkId", "counterAddress", "signerAddress"])(
    "rejects malformed %s",
    (field) => {
      expect(() => parseConfig({ ...valid, [field]: "bad" })).toThrow();
    },
  );
  it.each([
    "javascript:alert(1)",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?token=secret",
  ])("rejects invalid explorer targets", (explorerUrl) => {
    expect(() => parseConfig({ ...valid, explorerUrl })).toThrow();
  });
});
