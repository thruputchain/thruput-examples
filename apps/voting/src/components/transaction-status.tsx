import type { Transaction } from "../transactions/use-transaction";

export function TransactionStatus({
  transaction: tx,
}: {
  transaction: Transaction;
}) {
  if (!tx.pending && !tx.message && !tx.busy) return null;
  return (
    <section
      className="notice"
      aria-label="Transaction status"
      aria-live="polite"
    >
      {tx.pending ? (
        <>
          <h2>{tx.pending.label}</h2>
          <p>
            {tx.receipt.data
              ? tx.confirmed
                ? "Confirmed on-chain."
                : "Transaction committed, but execution failed. No changes were applied."
              : tx.receipt.error
                ? "Outcome unknown. Check the original transaction; do not submit another."
                : "Waiting for confirmation…"}
          </p>
          <p className="mono break-all">{tx.pending.record.hash}</p>
          <p className="muted break-all">
            Signed by {tx.pending.record.account.address}
          </p>
          <div className="actions">
            {tx.receipt.data ? (
              <button type="button" disabled={tx.busy} onClick={tx.finish}>
                Finish
              </button>
            ) : (
              <button
                type="button"
                disabled={tx.busy || tx.receipt.isFetching}
                onClick={() => void tx.receipt.refetch()}
              >
                Check transaction
              </button>
            )}
            {!tx.receipt.data ? (
              <button
                type="button"
                disabled={tx.busy || tx.storageError}
                onClick={tx.retrySubmission}
              >
                Submit original transaction
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(tx.pending, null, 2)], {
                    type: "application/json",
                  }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "voting-transaction.json";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export record
            </button>
          </div>
        </>
      ) : tx.busy ? (
        <p>Approve the transaction in your wallet.</p>
      ) : null}
      {tx.message ? <p role="alert">{tx.message}</p> : null}
      {tx.storageError ? (
        <button type="button" onClick={tx.retryStorage}>
          Retry storage
        </button>
      ) : null}
    </section>
  );
}
