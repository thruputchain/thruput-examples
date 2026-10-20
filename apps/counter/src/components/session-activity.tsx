import type { Snapshot } from "../transactions/engine";
import { BlockchainIdentifier } from "./blockchain-identifier";

export function SessionActivity({
  snapshot,
  explorerUrl,
  showMetrics = true,
}: {
  snapshot: Snapshot;
  explorerUrl: string | null;
  showMetrics?: boolean;
}) {
  const metrics = [
    ["Submitted", snapshot.submitted.toLocaleString()],
    ["Confirmed", snapshot.confirmed.toLocaleString()],
    ["Pending", snapshot.pending.toLocaleString()],
    ["Confirmed tx/s", snapshot.rate.toFixed(1)],
  ];
  return (
    <section
      aria-label="Transaction activity"
      className="flex flex-col gap-6 border-t pt-8"
    >
      {showMetrics ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <h2 id="activity-title" className="text-lg">
              This session
            </h2>
            <p className="text-base text-muted-foreground sm:text-sm">
              Rate over the last 5 seconds.
            </p>
          </div>
          <div className="@container">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-8 @xl:grid-cols-4">
              {metrics.map(([label, value]) => (
                <div key={label} className="flex min-w-0 flex-col gap-2">
                  <dt className="truncate text-base font-medium sm:text-sm">
                    {label}
                  </dt>
                  <dd
                    className="font-mono text-2xl tabular-nums text-muted-foreground"
                    data-metric={label}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {snapshot.failed > 0 ||
          snapshot.unknown > 0 ||
          snapshot.skipped > 0 ? (
            <p className="text-base text-muted-foreground sm:text-sm">
              {snapshot.failed.toLocaleString()} failed ·{" "}
              {snapshot.unknown.toLocaleString()} unknown ·{" "}
              {snapshot.skipped.toLocaleString()} inputs not accepted.
              {snapshot.unknown > 0
                ? " Unknown transactions are still being checked; they are not sent again."
                : ""}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-col gap-4">
        <h3 className="text-base">Recent transactions</h3>
        {snapshot.recent.length === 0 ? (
          <p className="py-5 text-base text-muted-foreground sm:text-sm">
            Your first transaction starts here. Press a button or try the
            keyboard.
          </p>
        ) : (
          <ol role="list" className="divide-y divide-border">
            {snapshot.recent.map((transaction) => (
              <li
                key={transaction.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-base first:pt-0 last:pb-0 sm:text-sm"
              >
                <div className="w-8 shrink-0 font-mono text-primary">
                  {transaction.direction === "increment" ? "+1" : "−1"}
                </div>
                <div className="min-w-0 flex-1 text-muted-foreground">
                  {transaction.hash ? (
                    <BlockchainIdentifier
                      value={transaction.hash}
                      kind="tx"
                      explorerUrl={explorerUrl}
                    />
                  ) : transaction.state === "failed" ? (
                    "Not sent"
                  ) : (
                    "Preparing…"
                  )}
                </div>
                <div
                  className={
                    transaction.state === "failed"
                      ? "text-destructive"
                      : transaction.state === "confirmed"
                        ? "text-local"
                        : "text-muted-foreground"
                  }
                >
                  {transaction.state.charAt(0).toUpperCase() +
                    transaction.state.slice(1)}
                </div>
                {transaction.message ? (
                  <p className="w-full break-words text-muted-foreground">
                    {transaction.message}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
