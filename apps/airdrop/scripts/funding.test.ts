import { expect, it } from "vitest";
import { storageFunding } from "./funding";

const costs = {
  baseContractDeploymentCost: 12000n,
  contractDeploymentCostPerByte: 1n,
  baseDataItemCost: 12000n,
  bytestringCostPerByte: 10n,
  balanceCost: 1234n,
  authPerKeyCost: 0n,
  rcqCostPerEntry: 0n,
  replayCacheCostPerEntry: 0n,
};
it("covers the maximum claim budget, allowlist, code, and new token balance rows", () => {
  for (const packs of [1000n, 10000n]) {
    const budget = storageFunding(costs, packs, 256, 50000);
    expect(budget.airdrop).toBeGreaterThan(
      (packs + 256n) * 12000n + 50000n + 12000n,
    );
    expect(budget.token).toBeGreaterThan((packs + 1n) * 12000n);
  }
});
it("uses the network's byte and base costs", () => {
  const budget = storageFunding(costs, 1000n, 0, 50000);
  const doubled = Object.fromEntries(
    Object.entries(costs).map(([key, value]) => [key, value * 2n]),
  ) as typeof costs;
  expect(storageFunding(doubled, 1000n, 0, 50000).airdrop).toBe(
    budget.airdrop * 2n,
  );
});
