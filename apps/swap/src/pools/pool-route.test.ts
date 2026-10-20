import {
  addressFromBase58,
  addressToStrkey,
  toBase58,
} from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { describe, expect, it } from "vitest";

import { parsePoolRoute, poolPath } from "./pool-route";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
// 31 zero bytes then `last`: 57 encodes as "1…1z" and 58 as "1…121", so base58
// text order puts 58 first while byte order puts 57 first.
const lowByte = (last: number) => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return toBase58(bytes);
};

describe("parsePoolRoute", () => {
  it("accepts canonical base58 addresses", () => {
    expect(parsePoolRoute(id(1), id(2))).toMatchObject({
      kind: "canonical",
      token0Base58: id(1),
      token1Base58: id(2),
    });
  });

  it("orders route tokens by address bytes, not base58 text", () => {
    expect(lowByte(57) > lowByte(58)).toBe(true);
    expect(parsePoolRoute(lowByte(57), lowByte(58))).toMatchObject({
      kind: "canonical",
    });
    expect(parsePoolRoute(lowByte(58), lowByte(57))).toEqual({
      kind: "invalid",
    });
  });

  it("redirects C StrKey routes to base58", () => {
    const strkey = addressToStrkey(addressFromBase58(id(0xab)));
    expect(parsePoolRoute(strkey, id(0xcd))).toEqual({
      kind: "redirect",
      token0Base58: id(0xab),
      token1Base58: id(0xcd),
    });
  });

  it("rejects reversed routes", () => {
    expect(parsePoolRoute(id(2), id(1))).toEqual({ kind: "invalid" });
  });

  it("rejects malformed, hex, zero, and identical addresses", () => {
    expect(parsePoolRoute("nope", id(2))).toEqual({ kind: "invalid" });
    expect(parsePoolRoute(`0x${"01".repeat(32)}`, id(2))).toEqual({
      kind: "invalid",
    });
    expect(parsePoolRoute(id(0), id(2))).toEqual({ kind: "invalid" });
    expect(parsePoolRoute(id(2), id(2))).toEqual({ kind: "invalid" });
  });
});

describe("poolPath", () => {
  it("builds a canonical base58 path in byte order", () => {
    expect(poolPath(address(2), address(1), "/swap")).toBe(
      `/pools/${id(1)}/${id(2)}/swap`,
    );
    expect(
      poolPath(addressFromBase58(lowByte(58)), addressFromBase58(lowByte(57))),
    ).toBe(`/pools/${lowByte(57)}/${lowByte(58)}`);
  });
});
