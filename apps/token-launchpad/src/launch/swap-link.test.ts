import { describe, expect, it } from "vitest";

import { createAmmPoolLink } from "@/launch/swap-link";
import type { LaunchWorkflow, StepStatus } from "@/launch/workflow";

const origin = "https://swap.example.test";
const createdAddressHex = `0x${"aB".repeat(32)}`;
const verified = {
  creation: { status: "committed", hash: `0x${"07".repeat(32)}` },
  verification: {
    status: "complete",
    message: null,
    totalSupply: "12",
    holderBalance: "12",
  },
  createdAddressHex,
  predictedAddressHex: `0x${"03".repeat(32)}`,
} satisfies Pick<
  LaunchWorkflow,
  "creation" | "verification" | "createdAddressHex" | "predictedAddressHex"
>;

describe("verified launch Swap link", () => {
  it.each([undefined, null, ""])("hides disabled configuration %s", (value) => {
    expect(createAmmPoolLink(value, verified)).toBeNull();
  });

  it("hides a missing workflow", () => {
    expect(createAmmPoolLink(origin, null)).toBeNull();
  });

  it.each<StepStatus>(["idle", "signing", "pending", "uncertain", "failed"])(
    "hides %s creation even with complete verification",
    (status) => {
      expect(
        createAmmPoolLink(origin, {
          ...verified,
          creation: { ...verified.creation, status },
        }),
      ).toBeNull();
    },
  );

  it.each(["pending", "incomplete"] as const)(
    "hides %s verification",
    (status) => {
      expect(
        createAmmPoolLink(origin, {
          ...verified,
          verification: { ...verified.verification, status },
        }),
      ).toBeNull();
    },
  );

  it.each([
    null,
    "",
    `0x${"00".repeat(32)}`,
    "not-an-address",
    `0x${"ab".repeat(31)}`,
    `0x${"ab".repeat(33)}`,
    `0x${"gg".repeat(32)}`,
    `0X${"ab".repeat(32)}`,
    "ab".repeat(32),
    ` ${createdAddressHex}`,
    `${createdAddressHex}\n`,
  ])(
    "rejects invalid verified address %j without using the prediction",
    (address) => {
      expect(
        createAmmPoolLink(origin, {
          ...verified,
          createdAddressHex: address,
        }),
      ).toBeNull();
    },
  );

  it.each([origin, "http://localhost:5174", "http://[::1]:5174"])(
    "links only the canonical actual address at %s",
    (destination) => {
      expect(createAmmPoolLink(destination, verified)).toBe(
        `${destination}/pools/new?tokenA=${createdAddressHex.toLowerCase()}`,
      );
    },
  );
});
