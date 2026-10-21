import {
  bytesEqual,
  hashSignedTransaction,
  serializeSignedTransaction,
  toBase58,
  type ThruputClient,
} from "@thruputchain/client";
import type { ExecutableWalletClient } from "@thruputchain/client/wallet";
import { SeedError } from "./seed-preflight.ts";

// Print evidence before sending. An uncertain submission is never retried.
export async function submitSeedTransaction(
  wallet: Pick<
    ExecutableWalletClient<ThruputClient>,
    | "prepareExecution"
    | "signTransaction"
    | "sendTransaction"
    | "waitForTransactionReceipt"
  >,
  name: string,
  request: Parameters<
    ExecutableWalletClient<ThruputClient>["prepareExecution"]
  >[0],
) {
  const signed = await wallet.signTransaction(
    await wallet.prepareExecution(request),
  );
  const hash = hashSignedTransaction(signed);
  console.log(`Submitting ${name}: ${toBase58(hash)}`);
  const returned = await wallet.sendTransaction({
    signedTransaction: serializeSignedTransaction(signed),
  });
  if (!bytesEqual(returned.transactionHash, hash))
    throw new SeedError("Submission hash mismatch");
  const receipt = await wallet.waitForTransactionReceipt(hash, {
    timeoutMs: 60_000,
  });
  if (
    !bytesEqual(receipt.transactionHash, hash) ||
    !("result" in receipt.execution) ||
    receipt.execution.result !== "return"
  )
    throw new SeedError("Transaction failed or receipt hash mismatched");
  console.log(`Completed ${name}: ${toBase58(hash)}`);
  return receipt;
}
