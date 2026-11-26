/**
 * Whether a saved wallet transaction committed, read without missing a
 * commit. The Voting app explains the pattern. Voting, Airdrop, Launchpad,
 * and Swap keep identical copies of this file.
 */
import {
  hashFromBase58,
  isThruputError,
  type CoreThruputClient,
} from "@thruputchain/client";

/**
 * How many blocks a transaction stays valid after it is prepared. It can
 * commit only in the `EXPIRY_BLOCKS` blocks that end at `expiresAt`.
 */
export const EXPIRY_BLOCKS = 1_000n;

/**
 * What the node can tell about a saved transaction:
 *
 * - `observe`: it committed, or it can still commit. Keep watching its hash.
 * - `notIndexed`: it can no longer commit, but the node has not indexed
 *   receipts through `expiresAt` yet, so a missing receipt proves nothing.
 * - `expired`: it never committed. The user can send again.
 * - `unknown`: the node no longer keeps the blocks that could hold it, so
 *   it may have committed. Keep the record; the user decides.
 */
export type SavedOutcome = "observe" | "notIndexed" | "expired" | "unknown";

type OutcomeReader = Pick<
  CoreThruputClient,
  | "getChainTip"
  | "getTransactionsByBlock"
  | "getTransactionStatus"
  | "getTransactionReceipt"
>;

/**
 * Decide what a saved transaction's outcome can be, without missing a
 * commit. The order of the reads matters:
 *
 * 1. The tip. At or below `expiresAt`, the transaction can still commit.
 * 2. How far the node has indexed receipts. Read before the receipt, so a
 *    block indexed between the two reads cannot hide a commit.
 * 3. The status, which reports a recent commit before its receipt is
 *    indexed, then the receipt.
 * 4. The oldest block the node keeps, again. A block pruned after step 2 can
 *    take a committed receipt with it, so the range must still cover every
 *    block that could hold the transaction after the receipt read.
 */
export async function readSavedOutcome(
  client: OutcomeReader,
  hash: string,
  expiresAt: bigint,
): Promise<SavedOutcome> {
  const tip = await client.getChainTip();
  if (tip.blockHeight <= expiresAt) return "observe";
  const indexed = await indexedRange(client, expiresAt);
  const transactionHash = hashFromBase58(hash);
  const status = await client.getTransactionStatus({ transactionHash });
  if ("status" in status && status.status === "committed") return "observe";
  if (await client.getTransactionReceipt({ transactionHash })) return "observe";
  if (indexed.latest < expiresAt) return "notIndexed";
  // The first block that could include the transaction (block 1 at the least).
  const first = expiresAt > EXPIRY_BLOCKS ? expiresAt - EXPIRY_BLOCKS + 1n : 1n;
  const kept = await indexedRange(client, expiresAt);
  // Without a reported range, nothing proves the window is kept.
  if (kept.oldest === null) return "unknown";
  // The final read must cover the whole window: an index now behind
  // `expiresAt` (a lagging node behind the same endpoint) proves nothing yet.
  if (kept.latest < expiresAt) return "notIndexed";
  if (kept.oldest > first) return "unknown";
  return "expired";
}

/** The blocks whose receipts the node has indexed. */
async function indexedRange(
  client: OutcomeReader,
  blockHeight: bigint,
): Promise<{ oldest: bigint | null; latest: bigint }> {
  try {
    const page = await client.getTransactionsByBlock({
      blockHeight,
      limit: 1,
      start: { order: "ascending" },
    });
    return {
      oldest: page.oldestIndexedBlockHeight,
      latest: page.latestIndexedBlockHeight,
    };
  } catch (error) {
    // A block outside the index is reported with the range the node has. A
    // missing bound is read as the cautious one: an unknown latest block
    // means wait, and an unknown oldest block proves nothing is kept.
    if (
      !isThruputError(error, "nativeRpcError") ||
      error.context.kind !== "historyUnavailable"
    )
      throw error;
    const { data } = error.context;
    return {
      oldest: data.oldestIndexedBlockHeight ?? null,
      latest: data.latestIndexedBlockHeight ?? blockHeight - 1n,
    };
  }
}
