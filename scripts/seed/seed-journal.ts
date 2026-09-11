import { randomBytes } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  bytesEqual,
  fromHex0x,
  hashSignedTransaction,
  toHex0x,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  deserializeSignedTransaction,
  serializeSignedTransaction,
} from "@groundhogchain/client/transaction";
import {
  ExecResult,
  sha256Hash,
  type SignedTransaction,
} from "@groundhogchain/protocol";

export interface Attempt {
  hash: string;
  signed: string;
  intent: string;
}

export interface SeedJournal {
  steps: Record<string, Attempt[]>;
}

/** Only locally authored messages are safe to print; SDK/RPC errors stay private. */
export class SeedError extends Error {}

/** Sync the entire ancestry, including existing entries left by an interrupted run. */
export async function durableMkdir(path: string): Promise<void> {
  const directory = resolve(path);
  const parent = dirname(directory);
  if (parent === directory) return;
  await durableMkdir(parent);
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  // Opening also rejects a file masquerading as an existing directory.
  const child = await open(directory, "r");
  try {
    if (!(await child.stat()).isDirectory())
      throw new SeedError("Seed state path is not a directory");
    await child.sync();
  } finally {
    await child.close();
  }
  const entry = await open(parent, "r");
  try {
    await entry.sync();
  } finally {
    await entry.close();
  }
}

/** fsync before rename, then fsync the directory before any network submission. */
export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function executeStep(options: {
  name: string;
  intent: string;
  journal: SeedJournal;
  save: () => Promise<void>;
  client: Pick<
    GroundhogClient,
    | "getTransactionReceipt"
    | "getTransactionStatus"
    | "getChainTip"
    | "sendTransaction"
    | "waitForTransactionReceipt"
  >;
  prepare: () => Promise<SignedTransaction>;
  retryFailed?: boolean;
}): Promise<TransactionReceipt> {
  const { name, journal, client, save } = options;
  const attempts = (journal.steps[name] ??= []);
  let attempt = attempts.at(-1);
  if (attempt) {
    if (attempt.intent !== options.intent)
      throw new SeedError("Seed transaction intent changed");
    const hash = sha256Hash(fromHex0x(attempt.hash));
    const signed = deserializeSignedTransaction(fromHex0x(attempt.signed));
    if (!bytesEqual(hashSignedTransaction(signed), hash))
      throw new SeedError("Seed journal hash mismatch");
    const receipt = await client.getTransactionReceipt(hash);
    if (receipt) {
      if (!bytesEqual(receipt.txHash, hash))
        throw new SeedError("Receipt hash mismatch");
      if (receipt.execResult === ExecResult.ExecResultOK) return receipt;
      if (!options.retryFailed)
        throw new SeedError(
          "Committed failure; fix the cause, then set SEED_RETRY_FAILED=1 to retry",
        );
      attempt = undefined;
    } else {
      const status = await client.getTransactionStatus(hash);
      if (status.status === "invalid" && options.retryFailed) {
        attempt = undefined;
      } else if (
        status.status === "unknown" ||
        status.status === "recentFailure"
      ) {
        // Re-submit identical bytes only while valid. An expired unknown hash is
        // not evidence of non-commitment (history may have been pruned).
        if (
          (await client.getChainTip()).height >
          signed.tx.uniquifier.block_expiry_height
        ) {
          throw new SeedError(
            "Expired unresolved transaction; preserve journal and investigate original hash",
          );
        }
        const returned = await client.sendTransaction(signed);
        if (!bytesEqual(returned, hash))
          throw new SeedError("Submission hash mismatch");
      } else if (status.status !== "pending" && status.status !== "committed") {
        throw new SeedError(
          "Unresolved transaction; SEED_RETRY_FAILED=1 is allowed only for authoritative failures",
        );
      }
    }
  }
  if (!attempt) {
    const signed = await options.prepare();
    attempt = {
      hash: toHex0x(hashSignedTransaction(signed)),
      signed: toHex0x(serializeSignedTransaction(signed)),
      intent: options.intent,
    };
    attempts.push(attempt);
    await save();
    const returned = await client.sendTransaction(signed);
    if (toHex0x(returned) !== attempt.hash)
      throw new SeedError("Submission hash mismatch");
  }
  const receipt = await client.waitForTransactionReceipt(
    sha256Hash(fromHex0x(attempt.hash)),
    { timeoutMs: 60_000 },
  );
  if (
    toHex0x(receipt.txHash) !== attempt.hash ||
    receipt.execResult !== ExecResult.ExecResultOK
  ) {
    throw new SeedError(
      "Transaction failed or receipt hash mismatched; inspect the recorded hash before retrying",
    );
  }
  return receipt;
}
