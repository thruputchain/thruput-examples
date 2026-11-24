import { fromHex0x, hashContract, toBase58 } from "@thruputchain/client";
import { ContractType, type Contract } from "@thruputchain/protocol";

/**
 * The LP token's contract code. Creating a pool deploys it in the same
 * transaction, so the factory can create the pool's LP token from it.
 *
 * Setup publishes the code under `public/contract-artifacts/<hash>.json`.
 * The app checks that the code matches the configured hash.
 */
export async function fetchPoolTokenArtifact(hash: string): Promise<Contract> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}contract-artifacts/${hash}.json`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error("The LP token code is unavailable.");
  return parsePoolTokenArtifact(await response.json(), hash);
}

/** Read a published artifact, and check its code against the expected hash. */
export function parsePoolTokenArtifact(value: unknown, hash: string): Contract {
  const data = (value as { data?: unknown } | null)?.data;
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data))
    throw new Error("The LP token code is malformed.");
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(data) },
  };
  if (toBase58(hashContract(contract)) !== hash)
    throw new Error("The LP token code does not match its configured hash.");
  return contract;
}
