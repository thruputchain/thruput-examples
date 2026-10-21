import { useState } from "react";
import { Link } from "react-router-dom";
import { useClient, useWallet } from "@thruputchain/react";
import { useQuery } from "@tanstack/react-query";
import { toBase58 } from "@thruputchain/client";
import { listPolls, statusName } from "../contracts/polls";
import type { AppConfig } from "../config";

export function PollList({
  config,
  admin = false,
}: {
  config: AppConfig;
  admin?: boolean;
}) {
  const client = useClient();
  const wallet = useWallet();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("All");
  const query = useQuery({
    queryKey: ["voting", "list", page],
    queryFn: () => listPolls(client, config, page),
    refetchInterval: 5_000,
  });
  const polls = query.data?.polls.filter(
    ({ poll }) =>
      (!admin || toBase58(poll.admin) === wallet.address) &&
      (filter === "All" || statusName(poll.status) === filter),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Voting example</p>
          <h1>{admin ? "My polls" : "Community polls"}</h1>
          <p className="muted">
            {admin
              ? "Create a poll, set the questions, and open it when you are ready."
              : "One wallet. One answer per question. Every result on-chain."}
          </p>
        </div>
      </div>
      <div className="section-heading">
        <div className="actions" aria-label="Filter polls">
          {["All", "Draft", "Open", "Closed"].map((status) => (
            <button
              type="button"
              key={status}
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
            >
              {status}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </button>
      </div>
      {admin && !wallet.address ? (
        <p className="notice">
          Connect your wallet to see the polls you manage.
        </p>
      ) : null}
      {query.isPending ? <p role="status">Loading polls…</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {polls?.length === 0 ? (
        <section className="empty">
          <h2>No matching polls on this page</h2>
          <p className="muted">
            {query.data?.count === 0n
              ? "Create the first poll to get started."
              : "Try another status or page."}
          </p>
        </section>
      ) : null}
      <ul role="list" className="poll-list">
        {polls?.map(({ id, poll }) => (
          <li key={id.toString()}>
            <Link to={`/polls/${id}`} className="poll-card">
              <div className="section-heading">
                <p className="mono muted">Poll #{id.toString()}</p>
                <span className="badge" data-status={statusName(poll.status)}>
                  {statusName(poll.status)}
                </span>
              </div>
              <h2>{poll.title}</h2>
              <p className="muted description">
                {poll.description || "No description."}
              </p>
              <p className="mono muted">
                {poll.question_count.toString()} questions ·{" "}
                {toBase58(poll.admin) === wallet.address
                  ? "Managed by you"
                  : `By ${toBase58(poll.admin).slice(0, 8)}…`}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      <nav className="actions" aria-label="Poll pages">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          Newer
        </button>
        <p className="mono">Page {page + 1}</p>
        <button
          type="button"
          disabled={!query.data || BigInt((page + 1) * 12) >= query.data.count}
          onClick={() => setPage((p) => p + 1)}
        >
          Older
        </button>
      </nav>
    </>
  );
}
