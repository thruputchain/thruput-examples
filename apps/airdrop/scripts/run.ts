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
  fromHex0x,
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
  anchorHash: string;
  status: "running" | "complete" | "failed";
  persona?: { name: string; address: string };
  airdropAddress?: string;
  transactions: TransactionRecord[];
  error?: string;
}

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      value,
      (_, item) => (typeof item === "bigint" ? String(item) : item),
      2,
    ) + "\n",
    { mode: 0o600, flush: true },
  );
  await rename(temporary, path);
}
export async function createRun(
  parent: string,
  networkHash: string,
  anchorHash: string,
) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(parent, `run-${new Date().toISOString().replaceAll(":", "-")}-`),
  );
  const manifest: Manifest = {
    networkHash,
    anchorHash,
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

export async function checkNetwork(client: Client, run: Run) {
  const [network, checkpoint] = await Promise.all([
    client.getNetworkInfo(),
    client.getBlockByHeight({ blockHeight: 1n }),
  ]);
  if (
    toBase58(network.networkHash) !== run.manifest.networkHash ||
    !checkpoint ||
    toBase58(checkpoint.blockHash) !== run.manifest.anchorHash
  )
    throw new Error("Network changed during provisioning.");
}

export async function createPersona(
  client: Client,
  run: Run,
  name: string,
  privateKey?: string,
) {
  const seed = privateKey ? fromHex0x(privateKey) : randomBytes(32);
  const account = createPubkeyAccount({ signer: Ed25519Signer.fromSeed(seed) });
  const address = toBase58(account.address);
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
      await checkNetwork(client, run);
      const transaction = run.manifest.transactions.at(-1);
      if (!transaction || transaction.status !== "unknown")
        throw new Error("Record transaction intent before signing.");
      const path = join(
        run.directory,
        `${String(run.manifest.transactions.length).padStart(3, "0")}.signed.json`,
      );
      await writeFile(
        path,
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

export async function record<T extends ExecutionResult | FundingResult>(
  run: Run,
  label: string,
  submit: () => Promise<T>,
): Promise<T> {
  const transaction: TransactionRecord = { label, status: "unknown" };
  run.manifest.transactions.push(transaction);
  await saveRun(run);
  const receiptPath = join(
    run.directory,
    `${String(run.manifest.transactions.length).padStart(3, "0")}.receipt.json`,
  );
  console.log(label);
  try {
    // Submit once; an uncertain outcome never grants permission to repeat a write.
    const result = await submit();
    let height: bigint;
    if ("receipt" in result) {
      transaction.hash = toBase58(result.transactionHash);
      await writeJson(receiptPath, result.receipt);
      assertTransactionSuccess(result.receipt);
      height = result.receipt.blockHeight;
    } else {
      transaction.hash = toBase58(result.hash);
      height = result.blockHeight;
    }
    run.latestBlockHeight =
      height > run.latestBlockHeight ? height : run.latestBlockHeight;
    transaction.status = "confirmed";
    return result;
  } catch (error) {
    transaction.status = statusFor(error);
    transaction.error = error instanceof Error ? error.message : String(error);
    const hash = hashFor(error);
    if (hash) transaction.hash = toBase58(hash);
    const receipt = receiptFor(error);
    if (receipt) await writeJson(receiptPath, receipt);
    throw error;
  } finally {
    await saveRun(run);
    console.log(
      `${label}: ${transaction.status}${transaction.hash ? ` (${transaction.hash})` : ""}`,
    );
  }
}
