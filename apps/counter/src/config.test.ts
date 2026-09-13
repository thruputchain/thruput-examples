import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const valid = {
  networkId: "00".repeat(32),
  counterAddress: "11".repeat(32),
  signerAddress: "22".repeat(32),
};
describe("configuration", () => {
  it("normalizes network, contract, and signer bytes", () => {
    expect(parseConfig(valid)).toMatchObject({
      networkId: `0x${valid.networkId}`,
      counterAddress: `0x${valid.counterAddress}`,
      explorerUrl: null,
    });
  });
  it("normalizes uppercase prefixes and hex digits", () => {
    expect(
      parseConfig({ ...valid, counterAddress: `0X${"AB".repeat(32)}` })
        .counterAddress,
    ).toBe(`0x${"ab".repeat(32)}`);
  });
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
