import { useState } from "react";
import type { useWalletCounter } from "./use-wallet-counter";
import { BlockchainIdentifier } from "../components/blockchain-identifier";

export function WalletActivity({
  activity,
  explorerUrl,
}: {
  activity: ReturnType<typeof useWalletCounter>;
  explorerUrl: string | null;
}) {
  const { pending, receipt, execution, busy, message } = activity;
  const knownReceipt =
    receipt.data && "result" in receipt.data.execution ? receipt.data : null;
  const [forget, setForget] = useState<string | null>(null);
  const recordIdentity = pending.record?.hash ?? "unreadable";
  const buttonClass =
    "self-start rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50";
  if (!pending.record && !pending.error && !message && !execution.isPending)
    return null;
  function exportRecord() {
    if (!pending.record) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ version: 1, ...pending.record }, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `counter-${pending.record.hash}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <section
      aria-label="Wallet transaction"
      className="flex min-w-0 flex-col gap-3 break-words border-t pt-6"
    >
      <h2 className="text-lg">Wallet transaction</h2>
      {busy ? (
        <p role="status">Waiting for wallet approval or confirmation…</p>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      {pending.error ? <p role="alert">{pending.error}</p> : null}
      {pending.record ? (
        <>
          <p>
            Original account{" "}
            <BlockchainIdentifier
              value={pending.record.account.address}
              kind="address"
              explorerUrl={explorerUrl}
            />
          </p>
          <p>
            Original network{" "}
            <code className="break-all">{pending.record.networkHash}</code>
          </p>
          <p>
            Transaction{" "}
            <BlockchainIdentifier
              value={pending.record.hash}
              kind="tx"
              explorerUrl={explorerUrl}
            />
          </p>
          {knownReceipt ? (
            <>
              <p role="status">
                {"result" in knownReceipt.execution &&
                knownReceipt.execution.result === "return"
                  ? "Counter update committed."
                  : "The transaction committed with failed execution."}
              </p>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={activity.clearRecord}
              >
                Finish
              </button>
            </>
          ) : (
            <>
              <p>
                A timeout does not cancel the transaction. Checking only reads
                its original hash. Retrying asks the original wallet to approve
                and submit the same signed transaction.
              </p>
              {receipt.error ? (
                <p role="alert">{receipt.error.message}</p>
              ) : null}
              <button
                type="button"
                className={buttonClass}
                disabled={busy || receipt.isFetching}
                onClick={() => void receipt.refetch()}
              >
                Check transaction
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || Boolean(pending.error)}
                onClick={activity.retrySubmission}
              >
                Retry same transaction
              </button>
            </>
          )}
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={exportRecord}
          >
            Export transaction record
          </button>
        </>
      ) : null}
      {pending.error ? (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={activity.retryStorage}
        >
          Retry storage
        </button>
      ) : null}
      {pending.error || (pending.record && !knownReceipt) ? (
        <>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => setForget(recordIdentity)}
          >
            Forget saved record
          </button>
          {forget === recordIdentity ? (
            <div role="alert">
              <p>
                Removing this browser record does not cancel a submitted
                transaction or prove it failed. Export readable evidence first.
                Sending a new update could apply the change twice.
              </p>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => {
                  activity.clearRecord();
                  setForget(null);
                }}
              >
                Confirm forget record
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => setForget(null)}
              >
                Keep record
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
