import {
  bytesEqual,
  hashSignedTransaction,
  toHex0x,
} from "@thruputchain/client";
import { DefaultWallet } from "@thruputchain/client/contracts";
import {
  parseSignedTransactionHex,
  parseSignTransactionResult,
  parseWalletAccount,
  parseWalletNetworkHash,
} from "@thruputchain/client/provider";
import type { PendingWalletTransaction } from "@thruputchain/client/wallet";
import { Counter } from "../contracts/generated/counter";

export type PendingState = {
  record: PendingWalletTransaction | null;
  error: string | null;
};
export function pendingKey(network: string, contract: string) {
  return `counter-wallet:v1:${network}:${contract}`;
}

export function loadPending(
  storage: Pick<Storage, "getItem">,
  key: string,
  network: string,
  contract: string,
): PendingState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { record: null, error: null };
    const data = JSON.parse(raw);
    if (data?.version !== 1)
      throw new Error("Unsupported saved transaction version");
    const signed = parseSignTransactionResult({
      signedTransaction: data.signedTransaction,
      hash: data.hash,
    });
    const account = parseWalletAccount(data.account);
    const networkHash = parseWalletNetworkHash(data.networkHash);
    if (networkHash !== network)
      throw new Error("Saved transaction belongs to another network");
    const tx = parseSignedTransactionHex(signed.signedTransaction);
    if (
      toHex0x(hashSignedTransaction(tx)) !== signed.hash ||
      toHex0x(tx.tx.invocation.invoked_address) !== account.address ||
      !bytesEqual(
        tx.tx.invocation.entrypoint,
        DefaultWallet.v0_1.execute.entrypoint,
      )
    )
      throw new Error("Saved transaction identity does not match");
    const { calls } = DefaultWallet.v0_1.execute.decodeArgs(
      tx.tx.invocation.calldata,
    );
    const call = calls[0];
    const method = [Counter.v0_1.increment, Counter.v0_1.decrement].find(
      (method) => call && bytesEqual(method.entrypoint, call.entrypoint),
    );
    if (
      calls.length !== 1 ||
      !call ||
      toHex0x(call.target) !== contract ||
      !method ||
      method.decodeArgs(call.calldata).amount !== 1n
    )
      throw new Error(
        "Saved transaction is not a one-unit update to this Counter",
      );
    return { record: { ...signed, account, networkHash }, error: null };
  } catch (error) {
    return {
      record: null,
      error:
        error instanceof Error
          ? error.message
          : "Cannot read saved transaction",
    };
  }
}

export function savePending(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  record: PendingWalletTransaction,
) {
  const existing = storage.getItem(key);
  if (existing && JSON.parse(existing).hash !== record.hash)
    throw new Error("Another Counter transaction is already saved");
  storage.setItem(key, JSON.stringify({ version: 1, ...record }));
}
