import { describe, expect, it } from "vitest";
import { toBase58 } from "@thruputchain/client";
import {
  crowdAccount,
  crowdFunding,
  MIN_CROWD_BALANCE,
  MINT_GAS,
} from "./crowd";
import { fundingRates } from "../scripts/index";

const costs = {
  baseDataItemCost: 12_000n,
  bytestringCostPerByte: 10n,
  baseContractDeploymentCost: 12_000n,
  contractDeploymentCostPerByte: 10n,
  authPerKeyCost: 1_111n,
  rcqCostPerEntry: 8n,
  replayCacheCostPerEntry: 7n,
  balanceCost: 1_234n,
};

describe("crowd", () => {
  it("derives the same account from the same seed and index", () => {
    const seed = new Uint8Array(32).fill(7);
    const first = toBase58(crowdAccount(seed, 0).address);
    expect(toBase58(crowdAccount(seed, 0).address)).toBe(first);
    expect(toBase58(crowdAccount(seed, 1).address)).not.toBe(first);
    expect(
      toBase58(crowdAccount(new Uint8Array(32).fill(8), 0).address),
    ).not.toBe(first);
  });

  it("funds an account for scheduling and its first deposits", () => {
    const amount = crowdFunding(costs);
    expect(amount).toBe(MINT_GAS + 1_234n + 12_000n + 100_000n);
    expect(amount).toBeGreaterThan(MIN_CROWD_BALANCE);
  });
});

describe("drop funding", () => {
  it("covers the actual storage of a mint, about 37,400 raw units", () => {
    const { base, perToken } = fundingRates(costs);
    expect(perToken).toBe(3n * (12_000n + 1_280n));
    expect(perToken).toBeGreaterThan(37_400n);
    // A 10,000-token drop needs about 40 native tokens (7 decimals).
    expect((base + perToken * 10_000n) / 10_000_000n).toBe(39n);
  });
});
