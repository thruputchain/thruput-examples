import type { RpcStorageCosts } from "@thruputchain/client";

export function storageFunding(
  costs: RpcStorageCosts,
  packs: bigint,
  addresses: number,
  codeBytes: number,
) {
  // Reserve a full KiB for each small map entry and 4 KiB for configuration.
  // These bounds exceed the encoded bool, balance, and reward-list sizes.
  const entry = costs.baseDataItemCost + 1024n * costs.bytestringCostPerByte;
  return {
    airdrop:
      costs.baseContractDeploymentCost +
      BigInt(codeBytes) * costs.contractDeploymentCostPerByte +
      costs.balanceCost +
      costs.baseDataItemCost +
      4096n * costs.bytestringCostPerByte +
      (packs + BigInt(addresses)) * entry,
    token: (packs + 1n) * entry,
  };
}
