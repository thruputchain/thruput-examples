import { toBase58 } from "@thruputchain/client";
import { describe, expect, it } from "vitest";

import { createAmmPoolLink } from "@/launch/swap-link";

const token = toBase58(new Uint8Array(32).fill(0xab));

describe("Swap link for a new token", () => {
  it("keeps the hosted Swap base path", () => {
    expect(createAmmPoolLink("https://examples.test/swap/", token)).toBe(
      `https://examples.test/swap/pools/new?tokenA=${token}`,
    );
  });

  it.each([undefined, null, ""])("hides disabled configuration %s", (value) => {
    expect(createAmmPoolLink(value, token)).toBeNull();
  });
});
