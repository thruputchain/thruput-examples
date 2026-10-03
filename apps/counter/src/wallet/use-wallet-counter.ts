import { useRef, useState } from "react";
import { addressFromHex, toHex0x, gasAmount, TransactionExecutionError, type TransactionReceipt } from "@groundhogchain/client";
import { contractViewQueryOptions, transactionReceiptQueryOptions, useClient, useExecute, useWaitForTransactionReceipt } from "@groundhogchain/react";
import { useQueryClient } from "@tanstack/react-query";
import { Counter } from "../contracts/generated/counter";
import type { Direction } from "../transactions/engine";
import { loadPending, pendingKey, savePending } from "./pending";

export function useWalletCounter(address: string) {
  const client = useClient();
  const queries = useQueryClient();
  const execution = useExecute();
  const lock = useRef(false);
  const network = toHex0x(client.network.networkHash).slice(2);
  const key = pendingKey(network, address);
  const [pending, setPending] = useState(() => {
    try { return loadPending(localStorage, key, network); }
    catch { return { record: null, error: "Browser storage is unavailable." }; }
  });
  const receipt = useWaitForTransactionReceipt({ hash: execution.isPending ? null : pending.record?.hash ?? null });
  const blocked = execution.isPending || Boolean(pending.record || pending.error);

  function committed(value: TransactionReceipt) {
    queries.setQueryData(transactionReceiptQueryOptions({ client, hash: toHex0x(value.txHash) }).queryKey, value);
    void queries.invalidateQueries({ queryKey: contractViewQueryOptions({ client, method: Counter.v0_1.get, contract: addressFromHex(address) }).queryKey });
  }
  function send(direction: Direction) {
    if (lock.current || blocked) return;
    lock.current = true;
    execution.mutate({
      request: { invocation: Counter.v0_1[direction].invocation(addressFromHex(address), gasAmount(500_000n), { amount: 1n }), gasLimit: gasAmount(1_000_000n) },
      options: { onSigned: async record => { savePending(localStorage, key, record); setPending({ record, error: null }); } },
    }, {
      onSuccess: result => committed(result.receipt),
      onError: error => { if (error instanceof TransactionExecutionError) committed(error.receipt); },
      onSettled: () => { lock.current = false; },
    });
  }
  function finish() {
    if (!receipt.data) return;
    try { localStorage.removeItem(key); setPending({ record: null, error: null }); execution.reset(); }
    catch { setPending(state => ({ ...state, error: "Cannot clear the saved transaction." })); }
  }
  return { blocked, send, finish, pending, receipt, execution };
}
