import { createHash } from "node:crypto";
import {
  createPubkeyAccount,
  Ed25519Signer,
  type PubkeyAccount,
  type StorageCosts,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";

/** Gas each rush mint declares. A mint with six traits uses about 350,000. */
export const MINT_GAS = gasAmount(500_000n);

/** The largest crowd: one account for each token of the largest drop. */
export const MAX_CROWD_SIZE = 10_000;

/**
 * Crowd account `index`. Every key comes from one private seed, so the
 * environment holds one secret instead of 10,000 keys.
 */
export function crowdAccount(seed: Uint8Array, index: number): PubkeyAccount {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index);
  const key = createHash("sha256").update(seed).update(indexBytes).digest();
  return createPubkeyAccount({
    signer: Ed25519Signer.fromSeed(new Uint8Array(key)),
  });
}

/**
 * Native-token raw units that keep a crowd account able to mint. Scheduling
 * reserves one raw unit for each unit of declared gas but does not spend it,
 * and the drop pays for the minted token's storage. The account pays only for
 * its balance row and its first transaction's replay entry, so one funding
 * lasts for every later rush.
 */
export function crowdFunding(costs: StorageCosts): bigint {
  return (
    MINT_GAS +
    BigInt(costs.balanceCost) +
    BigInt(costs.baseDataItemCost) +
    100_000n
  );
}

/** Accounts below this balance cannot schedule a mint. */
export const MIN_CROWD_BALANCE = MINT_GAS + 20_000n;
