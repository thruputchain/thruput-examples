import { toBase58 } from "@thruputchain/client";
import { describe, expect, it } from "vitest";

import { createAmmPoolLink } from "@/launch/swap-link";
import type { LaunchWorkflow, StepStatus } from "@/launch/workflow";

const origin = "https://swap.example.test";
const createdAddress = toBase58(new Uint8Array(32).fill(0xab));
const verified = {
  creation: {
    status: "committed",
    hash: toBase58(new Uint8Array(32).fill(0x07)),
  },
  verification: {
    status: "complete",
    message: null,
    totalSupply: "12",
    holderBalance: "12",
  },
  createdAddress,
  predictedAddress: toBase58(new Uint8Array(32).fill(0x03)),
} satisfies Pick<
  LaunchWorkflow,
  "creation" | "verification" | "createdAddress" | "predictedAddress"
>;

describe("verified launch Swap link", () => {
  it("keeps the hosted Swap base path", () => {
    expect(createAmmPoolLink("https://examples.test/swap/", verified)).toBe(
      `https://examples.test/swap/pools/new?tokenA=${createdAddress}`,
    );
  });
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
    toBase58(new Uint8Array(32).fill(0x00)),
    "not-an-address",
    toBase58(new Uint8Array(31).fill(0xab)),
    toBase58(new Uint8Array(33).fill(0xab)),
    `0${createdAddress.slice(1)}`,
    `0x${"ab".repeat(32)}`,
    "ab".repeat(32),
    ` ${createdAddress}`,
    `${createdAddress}\n`,
  ])(
    "rejects invalid verified address %j without using the prediction",
    (address) => {
      expect(
        createAmmPoolLink(origin, {
          ...verified,
          createdAddress: address,
        }),
      ).toBeNull();
    },
  );

  it.each([origin, "http://localhost:5174", "http://[::1]:5174"])(
    "links only the canonical actual address at %s",
    (destination) => {
      expect(createAmmPoolLink(destination, verified)).toBe(
        `${destination}/pools/new?tokenA=${createdAddress}`,
      );
    },
  );
});
