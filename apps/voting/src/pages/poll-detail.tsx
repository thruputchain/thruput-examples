import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useClient, useWallet } from "@thruputchain/react";
import { useQuery } from "@tanstack/react-query";
import { toBase58 } from "@thruputchain/client";
import {
  GAS,
  methods,
  percentage,
  readPoll,
  statusName,
  type Poll,
} from "../contracts/polls";
import type { AppConfig } from "../config";
import type { Transaction } from "../transactions/use-transaction";
import { PollEditor } from "../components/poll-editor";

export function PollDetail({
  config,
  transaction: tx,
}: {
  config: AppConfig;
  transaction: Transaction;
}) {
  const params = useParams();
  const id =
    params.id &&
    /^(0|[1-9][0-9]*)$/.test(params.id) &&
    BigInt(params.id) < 2n ** 64n
      ? BigInt(params.id)
      : null;
  const client = useClient();
  const wallet = useWallet();
  const [selectedQuestion, setQuestion] = useState(0);
  const [edit, setEdit] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["voting", "poll", params.id, wallet.address],
    enabled: id !== null,
    queryFn: () => readPoll(client, config, id!, wallet.address ?? undefined),
    refetchInterval: 4_000,
  });
  if (id === null) return <p role="alert">Invalid poll link.</p>;
  if (!query.data)
    return (
      <p role={query.error ? "alert" : "status"}>
        {query.error?.message ?? "Loading poll…"}
      </p>
    );
  const { poll, participants, totals, answers } = query.data;
  const question = Math.min(
    selectedQuestion,
    Math.max(0, poll.definition.questions.length - 1),
  );
  const isAdmin = toBase58(poll.admin) === wallet.address;
  const canWrite = wallet.status === "connected" && !tx.blocked;
  const q = poll.definition.questions[question];
  return (
    <>
      <Link to="/">← All polls</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            Poll #{id.toString()} · {statusName(poll.status)}
          </p>
          <h1>{poll.definition.title}</h1>
          <p className="muted description">{poll.definition.description}</p>
        </div>
        <p className="mono">{participants.toString()} participants</p>
      </div>
      {query.error ? (
        <p role="alert">Could not refresh. Showing the last successful read.</p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          aria-label="Copy poll link"
          onClick={() => {
            setCopiedId(null);
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => setCopiedId(params.id ?? null))
              .catch(() =>
                window.prompt("Copy this poll link", window.location.href),
              );
          }}
        >
          {copiedId === params.id ? (
            <CheckIcon size={16} />
          ) : (
            <CopyIcon size={16} />
          )}
        </button>
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </button>
        {isAdmin && poll.status === 0n ? (
          <>
            <button
              type="button"
              disabled={tx.blocked}
              onClick={() => setEdit(!edit)}
            >
              {edit ? "View draft" : "Edit draft"}
            </button>
            <button
              type="button"
              disabled={!canWrite || !poll.definition.questions.length || edit}
              onClick={() => {
                if (
                  window.confirm(
                    "Open this poll? Its questions and options will become final.",
                  )
                )
                  tx.send(
                    "Open poll",
                    methods.openPoll.invocation(config.address, GAS, { id }),
                  );
              }}
            >
              Open poll
            </button>
          </>
        ) : null}
        {isAdmin && poll.status === 1n ? (
          <button
            type="button"
            disabled={!canWrite}
            onClick={() => {
              if (
                window.confirm(
                  "Close this poll permanently? No more answers will be accepted.",
                )
              )
                tx.send(
                  "Close poll",
                  methods.closePoll.invocation(config.address, GAS, { id }),
                );
            }}
          >
            Close poll
          </button>
        ) : null}
      </div>
      {edit && isAdmin && poll.status === 0n ? (
        <PollEditor
          key={`${id}-edit`}
          initial={poll.definition}
          disabled={!canWrite}
          onSave={(definition) => {
            tx.send(
              "Save draft",
              methods.editPoll.invocation(config.address, GAS, {
                id,
                definition,
              }),
            );
          }}
        />
      ) : (
        <>
          {poll.status === 0n ? (
            <p className="notice">
              This is a draft. Voting starts when the admin opens the poll.
            </p>
          ) : null}
          {poll.status === 2n ? (
            <p className="notice">
              This poll is closed. The results are final.
            </p>
          ) : null}
          {poll.definition.questions.length ? (
            <>
              <nav className="question-nav" aria-label="Questions">
                {poll.definition.questions.map((_, index) => (
                  <button
                    type="button"
                    key={index}
                    aria-current={question === index ? "step" : undefined}
                    onClick={() => setQuestion(index)}
                  >
                    {index + 1}
                    {answers[index] != null ? " ✓" : ""}
                  </button>
                ))}
              </nav>
              {wallet.address && poll.status !== 0n ? (
                <p className="mono muted">
                  {answers.filter((a) => a !== null).length} of{" "}
                  {poll.definition.questions.length} answered
                </p>
              ) : null}
              {q ? (
                <Question
                  key={`${id}-${question}-${wallet.address}`}
                  poll={poll}
                  index={question}
                  answer={answers[question] ?? null}
                  totals={totals[question] ?? []}
                  disabled={!canWrite || poll.status !== 1n}
                  connected={wallet.status === "connected"}
                  onVote={(option) =>
                    tx.send(
                      "Submit answer",
                      methods.vote.invocation(config.address, GAS, {
                        id,
                        question: BigInt(question),
                        option: BigInt(option),
                      }),
                    )
                  }
                />
              ) : null}
            </>
          ) : (
            <p className="empty">
              No questions yet. Add questions before opening the poll.
            </p>
          )}
        </>
      )}
    </>
  );
}

function Question({
  poll,
  index,
  answer,
  totals,
  disabled,
  connected,
  onVote,
}: {
  poll: Poll;
  index: number;
  answer: bigint | null;
  totals: bigint[];
  disabled: boolean;
  connected: boolean;
  onVote(option: number): void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const q = poll.definition.questions[index]!;
  const total = totals.reduce((sum, count) => sum + count, 0n);
  return (
    <div className="question-layout">
      <section className="ballot">
        <p className="eyebrow">Question {index + 1}</p>
        <h2>{q.title}</h2>
        <fieldset disabled={disabled || answer !== null} className="options">
          <legend className="sr-only">Choose one option</legend>
          {q.options.map((option, i) => (
            <label className="option" key={i}>
              <input
                type="radio"
                name={`answer-${index}`}
                value={i}
                checked={
                  answer !== null ? answer === BigInt(i) : selected === i
                }
                onChange={() => setSelected(i)}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
        {answer !== null ? (
          <p className="notice">Your answer is confirmed and cannot change.</p>
        ) : poll.status === 1n ? (
          <>
            <p className="muted">
              {connected
                ? "Choose one option. Your submitted answer is final."
                : "Connect your wallet to answer this question."}
            </p>
            <button
              type="button"
              className="primary"
              disabled={disabled || selected === null}
              onClick={() => {
                if (
                  selected !== null &&
                  window.confirm(
                    `Submit “${q.options[selected]}”? You cannot change this answer.`,
                  )
                )
                  onVote(selected);
              }}
            >
              Submit answer
            </button>
          </>
        ) : null}
      </section>
      <section className="results">
        <p className="eyebrow">
          {poll.status === 2n ? "Final results" : "Live results"}
        </p>
        <h2>{total.toString()} answers</h2>
        <ul role="list">
          {q.options.map((option, i) => {
            const count = totals[i] ?? 0n;
            const percent = percentage(count, total);
            return (
              <li key={i}>
                <div className="section-heading">
                  <p>{option}</p>
                  <p className="mono">
                    {count.toString()} · {percent}%
                  </p>
                </div>
                <progress
                  value={Number(percent)}
                  max={100}
                  aria-label={`${option}: ${percent}%`}
                />
              </li>
            );
          })}
        </ul>
        <p className="muted">
          Public on-chain votes. One wallet does not necessarily mean one
          person.
        </p>
      </section>
    </div>
  );
}
