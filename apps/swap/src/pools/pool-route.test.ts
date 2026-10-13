import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it } from "vitest";

import { parsePoolRoute, poolPath } from "./pool-route";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

describe("parsePoolRoute", () => {
  it("accepts canonical lowercase addresses", () => {
    expect(parsePoolRoute(hex(1), hex(2))).toMatchObject({
      kind: "canonical",
      token0Hex: hex(1),
      token1Hex: hex(2),
    });
  });

  it("redirects mixed-case canonical routes", () => {
    expect(parsePoolRoute(hex(0xab).toUpperCase().replace("0X", "0x"), hex(0xcd)))
      .toEqual({
        kind: "redirect",
        token0Hex: hex(0xab),
        token1Hex: hex(0xcd),
      });
  });

  it("rejects reversed routes", () => {
    expect(parsePoolRoute(hex(2), hex(1))).toEqual({ kind: "invalid" });
  });

  it("rejects malformed, zero, and identical addresses", () => {
    expect(parsePoolRoute("nope", hex(2))).toEqual({ kind: "invalid" });
    expect(parsePoolRoute(hex(0), hex(2))).toEqual({ kind: "invalid" });
    expect(parsePoolRoute(hex(2), hex(2))).toEqual({ kind: "invalid" });
  });
});

describe("poolPath", () => {
  it("builds a canonical path", () => {
    expect(poolPath(address(2), address(1), "/swap"))
      .toBe(`/pools/${hex(1)}/${hex(2)}/swap`);
  });
});
