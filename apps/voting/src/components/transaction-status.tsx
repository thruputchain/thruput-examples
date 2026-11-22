import type { Transaction } from "../transactions/use-transaction";

export function TransactionStatus({
  transaction: tx,
}: {
  transaction: Transaction;
}) {
  if (!tx.pending && !tx.message && !tx.busy)
    return tx.completed ? <p role="status">{tx.completed} confirmed.</p> : null;
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
            {tx.waitTimedOut
              ? "No receipt yet. The transaction can still commit, so do not send it again."
              : "Waiting for confirmation…"}
          </p>
          <p className="mono break-all">{tx.pending.hash}</p>
          <div className="actions">
              <button type="button" onClick={() => void tx.checkAgain()}>
                Check again
              </button>
              <button type="button" onClick={() => void tx.retry()}>
                Retry saved transaction
              </button>
          </div>
        </>
      ) : tx.busy ? (
        <p>Approve the transaction in your wallet.</p>
      ) : null}
      {tx.message ? <p role="alert">{tx.message}</p> : null}
    </section>
  );
}
