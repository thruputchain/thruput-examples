import { contractAddress } from "@groundhogchain/protocol";
import { describe, expect, it } from "vitest";

import { orderTokens, orientReserves } from "./tokens";

const low = contractAddress(Uint8Array.from({ length: 32 }, (_, index) => index));
const high = contractAddress(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);

describe("orderTokens", () => {
  it("orients reserves when input is token0", () => {
    const ordered = orderTokens(low, high);
    expect(ordered.inputIndex).toBe(0);
    expect(orientReserves([10n, 20n], ordered.inputIndex)).toEqual({
      reserveIn: 10n,
      reserveOut: 20n,
    });
  });

  it("orients reserves when input is token1", () => {
    const ordered = orderTokens(high, low);
    expect(ordered.inputIndex).toBe(1);
    expect(orientReserves([10n, 20n], ordered.inputIndex)).toEqual({
      reserveIn: 20n,
      reserveOut: 10n,
    });
  });

  it("rejects identical tokens", () => {
    expect(() => orderTokens(low, low)).toThrow("must differ");
  });
});
