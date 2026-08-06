import { describe, expect, it } from "vitest";

import { allowanceDifference, I128_MAX } from "./allowance";

describe("allowanceDifference", () => {
  it("returns the exact increase", () => {
    expect(allowanceDifference(15n, 10n)).toEqual({
      ok: true,
      difference: 5n,
    });
  });

  it("returns the exact reduction", () => {
    expect(allowanceDifference(10n, 15n)).toEqual({
      ok: true,
      difference: -5n,
    });
  });

  it("rejects signed i128 overflow", () => {
    expect(allowanceDifference(I128_MAX + 1n, 0n)).toEqual({
      ok: false,
      error: "outOfRange",
    });
  });
});
