import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Ed25519Signer,
  ExecutionDecodeError,
  ExecutionReturnUnavailableError,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  UnsupportedRpcValue,
  assertTransactionSuccess,
  createPubkeyAccount,
  createWalletClient,
  toBase58,
  toHex0x,
  type ConnectedThruputClient,
  type Cluster,
  type ExecutionResult,
} from "@thruputchain/client";

export type Client = ConnectedThruputClient<Cluster<readonly ["airdrop"]>>;
type Status = "confirmed" | "failed" | "unknown";

interface TransactionRecord {
  label: string;
  status: Status;
  hash?: string;
  error?: string;
}

interface Manifest {
  networkHash: string;
  status: "running" | "complete" | "failed";
  persona?: { name: string; address: string };
  addresses?: {
    handler: string;
    driver: string;
    factory: string;
    router: string;
  };
  transactions: TransactionRecord[];
  error?: string;
}

async function writeJson(path: string, value: unknown) {
  // Replace atomically; private keys and run records are readable only by the owner.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
  await rename(temporary, path);
}

export async function createRun(parent: string, networkHash: string) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const directory = await mkdtemp(join(parent, `run-${timestamp}-`));
  const manifest: Manifest = {
    networkHash,
    status: "running",
    transactions: [],
  };
  const run = { directory, manifest, latestBlockHeight: 0n };
  await saveRun(run);
  return run;
}

export type Run = Awaited<ReturnType<typeof createRun>>;

export function saveRun(run: Run) {
  return writeJson(join(run.directory, "manifest.json"), run.manifest);
}

export async function createPersona(client: Client, run: Run, name: string) {
  const seed = randomBytes(32);
  const account = createPubkeyAccount({ signer: Ed25519Signer.fromSeed(seed) });
  const address = toBase58(account.address);
  // Keep the key before funding so an interrupted setup does not lose its account.
  await writeJson(join(run.directory, "key.json"), {
    seed: toHex0x(seed),
    accountNonce: account.nonce.toString(),
    address,
  });
  run.manifest.persona = { name, address };
  await saveRun(run);
  const wallet = createWalletClient({
    client,
    account,
    // The SDK awaits this hook before broadcast. Failure prevents submission.
    onSigned: async (evidence) => {
      const transaction = run.manifest.transactions.at(-1);
      if (!transaction || transaction.status !== "unknown")
        throw new Error("Record transaction intent before signing.");
      await writeFile(
        join(
          run.directory,
          `${String(run.manifest.transactions.length).padStart(3, "0")}.signed.json`,
        ),
        JSON.stringify({
          network: toBase58(evidence.networkHash),
          hash: toBase58(evidence.transactionHash),
          signed: toHex0x(evidence.signedTransaction),
        }) + "\n",
        { flag: "wx", mode: 0o600, flush: true },
      );
      transaction.hash = toBase58(evidence.transactionHash);
      await saveRun(run);
    },
  });
  return { name, address, account, wallet };
}

export type Persona = Awaited<ReturnType<typeof createPersona>>;

function receiptFor(error: unknown) {
  if (
    error instanceof TransactionExecutionError ||
    error instanceof ExecutionDecodeError ||
    error instanceof ExecutionReturnUnavailableError
  )
    return error.receipt;
}

function statusFor(error: unknown): Status {
  if (error instanceof FundingObservationError) return statusFor(error.cause);
  const execution = receiptFor(error)?.execution;
  if (execution && !(execution instanceof UnsupportedRpcValue))
    return execution.result === "return" ? "confirmed" : "failed";
  if (
    error instanceof TransactionObservationError &&
    error.phase === "beforeSubmission"
  )
    return "failed";
  return "unknown";
}

function hashFor(error: unknown): Uint8Array | undefined {
  if (error instanceof TransactionObservationError)
    return error.transactionHash;
  if (error instanceof FundingObservationError) {
    const response = error.lastResponse;
    return (
      error.knownCommitment?.transactionHash ??
      (response && !(response instanceof UnsupportedRpcValue)
        ? response.transactionHash
        : undefined) ??
      hashFor(error.cause)
    );
  }
  return receiptFor(error)?.transactionHash;
}

interface FundingResult {
  hash: Uint8Array;
  blockHeight: bigint;
}

export async function record(
  run: Run,
  label: string,
  submit: () => Promise<ExecutionResult | FundingResult>,
) {
  // Persist intent first. An interrupted operation remains unknown, not failed.
  const transaction: TransactionRecord = { label, status: "unknown" };
  run.manifest.transactions.push(transaction);
  await saveRun(run);
  console.log(label);
  try {
    // Submit once: a timeout does not prove that nothing executed.
    const result = await submit();
    let height: bigint;
    if ("receipt" in result) {
      transaction.hash = toBase58(result.transactionHash);
      assertTransactionSuccess(result.receipt);
      height = result.receipt.blockHeight;
    } else {
      transaction.hash = toBase58(result.hash);
      height = result.blockHeight;
    }
    run.latestBlockHeight =
      height > run.latestBlockHeight ? height : run.latestBlockHeight;
    transaction.status = "confirmed";
  } catch (error) {
    transaction.status = statusFor(error);
    transaction.error = error instanceof Error ? error.message : String(error);
    const hash = hashFor(error);
    if (hash) transaction.hash = toBase58(hash);
    throw error;
  } finally {
    await saveRun(run);
    console.log(
      `${label}: ${transaction.status}${transaction.hash ? ` (${transaction.hash})` : ""}`,
    );
  }
}
