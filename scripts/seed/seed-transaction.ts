import {
  bytesEqual,
  hashSignedTransaction,
  toHex0x,
  type ThruputClient,
} from "@thruputchain/client";
import type { ExecutableWalletClient } from "@thruputchain/client/wallet";
import { ExecResult } from "@thruputchain/protocol";
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
  console.log(`Submitting ${name}: ${toHex0x(hash)}`);
  const returned = await wallet.sendTransaction(signed);
  if (!bytesEqual(returned, hash))
    throw new SeedError("Submission hash mismatch");
  const receipt = await wallet.waitForTransactionReceipt(hash, {
    timeoutMs: 60_000,
  });
  if (
    !bytesEqual(receipt.txHash, hash) ||
    receipt.execResult !== ExecResult.ExecResultOK
  )
    throw new SeedError("Transaction failed or receipt hash mismatched");
  console.log(`Completed ${name}: ${toHex0x(hash)}`);
  return receipt;
}
