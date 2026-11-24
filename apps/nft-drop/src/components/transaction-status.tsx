import type { Transaction } from "../transactions/use-transaction";

/** The wallet transaction's state: waiting, saved after a reload, or done. */
export function TransactionStatus({
  transaction: tx,
}: {
  transaction: Transaction;
}) {
  if (tx.unreadable)
    return (
      <section className="notice" role="alert">
        <h2>Unreadable saved transaction</h2>
        <p>Keep this record if you need it, then clear it to continue.</p>
        <p className="mono break-all">{tx.unreadable}</p>
        <div className="actions">
          <button type="button" onClick={tx.clearUnreadable}>
            Clear record
          </button>
        </div>
      </section>
    );
  if (tx.pending)
    return (
      <section className="notice" aria-live="polite">
        <h2>{tx.pending.label}</h2>
        <p>
          {tx.receipt.error
            ? "No result yet. The transaction may still commit; do not send another."
            : "Waiting for the transaction to commit…"}
        </p>
        <p className="mono break-all">{tx.pending.hash}</p>
        {tx.receipt.error ? (
          <div className="actions">
            <button type="button" onClick={() => void tx.receipt.refetch()}>
              Check again
            </button>
          </div>
        ) : null}
      </section>
    );
  if (tx.busy)
    return (
      <p className="notice" aria-live="polite">
        Approve the transaction in your wallet.
      </p>
    );
  if (tx.message)
    return (
      <p className="notice" role="alert">
        {tx.message}
      </p>
    );
  if (tx.completed && !tx.completed.ok)
    return (
      <section className="notice" role="alert">
        <h2>{tx.completed.label} failed</h2>
        <p>{tx.completed.message}</p>
        <div className="actions">
          <button type="button" onClick={tx.dismiss}>
            Dismiss
          </button>
        </div>
      </section>
    );
  return null;
}
