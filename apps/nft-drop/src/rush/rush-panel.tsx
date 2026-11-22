import { useState } from "react";
import { errorMessage } from "../config";
import { isActive, useRush, type RushSnapshot } from "./use-rush";

const number = (value: number) => value.toLocaleString();
const seconds = (ms: number | null) =>
  ms === null ? "–" : `${(ms / 1_000).toFixed(1)} s`;

/** Start a rush of simulated users against this drop, and watch it land. */
export function RushPanel({
  drop,
  crowdSize,
}: {
  drop: string;
  crowdSize: number;
}) {
  const { rush, start } = useRush();
  const [users, setUsers] = useState(String(Math.min(crowdSize, 10_000)));
  const [windowSeconds, setWindowSeconds] = useState("5");
  const active = isActive(rush);
  const here = rush?.drop === drop ? rush : null;
  const usersValue = Number(users);
  const windowValue = Number(windowSeconds);
  const valid =
    Number.isInteger(usersValue) &&
    usersValue >= 1 &&
    usersValue <= crowdSize &&
    windowSeconds.trim() !== "" &&
    windowValue >= 0 &&
    windowValue <= 60;

  if (crowdSize === 0)
    return (
      <section className="panel">
        <h2>Rush</h2>
        <p className="muted">
          No simulated users are configured. Run setup:local to create them.
        </p>
      </section>
    );

  return (
    <section className="panel rush" aria-labelledby="rush-heading">
      <div className="section-heading">
        <div>
          <h2 id="rush-heading">Rush</h2>
          <p className="muted">
            Simulated users each sign one mint with their own account. Every
            mint arrives at a random time in the window.
          </p>
        </div>
      </div>
      <form
        className="rush-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            start.mutate({
              drop,
              users: usersValue,
              windowSeconds: windowValue,
            });
        }}
      >
        <label>
          Users
          <input
            name="users"
            type="number"
            min={1}
            max={crowdSize}
            value={users}
            onChange={(e) => setUsers(e.target.value)}
          />
          <span className="presets">
            {[100, 1_000, 10_000]
              .filter((n) => n <= crowdSize)
              .map((n) => (
                <button
                  key={n}
                  type="button"
                  className="small"
                  onClick={() => setUsers(String(n))}
                >
                  {number(n)}
                </button>
              ))}
          </span>
        </label>
        <label>
          Window (seconds)
          <input
            name="window"
            type="number"
            min={0}
            max={60}
            step="any"
            value={windowSeconds}
            onChange={(e) => setWindowSeconds(e.target.value)}
          />
          <span className="presets">
            {[0, 5, 30].map((n) => (
              <button
                key={n}
                type="button"
                className="small"
                onClick={() => setWindowSeconds(String(n))}
              >
                {n === 0 ? "All at once" : `${n} s`}
              </button>
            ))}
          </span>
        </label>
        <div className="rush-start">
          <button
            type="submit"
            className="primary"
            disabled={!valid || active || start.isPending}
          >
            {active ? "Rush running…" : "Start rush"}
          </button>
        </div>
      </form>
      {start.error ? <p role="alert">{errorMessage(start.error)}</p> : null}
      {active && !here ? (
        <p className="muted">A rush is running on another drop.</p>
      ) : null}
      {here ? <LiveView rush={here} /> : null}
    </section>
  );
}

function phaseText(rush: RushSnapshot) {
  switch (rush.phase) {
    case "preparing":
      return `Signing ${number(rush.signed)} of ${number(rush.users)} mints…`;
    case "running":
      return `Sending: ${number(rush.submitted)} of ${number(rush.users)} submitted…`;
    case "settling":
      return "Waiting for the last outcomes…";
    case "done":
      return `Finished: ${number(rush.users)} users over ${rush.windowSeconds} s`;
    default:
      return "The rush stopped.";
  }
}

export function LiveView({ rush }: { rush: RushSnapshot }) {
  const { outcomes, blocks, conflicts } = rush;
  const peak = blocks.reduce(
    (best, block) => (block.minted > (best?.minted ?? 0) ? block : best),
    blocks[0],
  );
  const tallest = peak?.minted ?? 1;
  // On a node that makes one block for each transaction, every mint lands alone.
  const oneBlockEach =
    outcomes.minted >= 20 && blocks.length >= outcomes.minted * 0.9;

  return (
    <div className="live" aria-live="polite">
      <p className="eyebrow">{phaseText(rush)}</p>
      {peak ? (
        <p className="headline">
          <span className="mono">{number(peak.minted)}</span> mints in block{" "}
          <span className="mono">{number(Number(peak.height))}</span>.{" "}
          <span className="mono">{number(conflicts.other)}</span> conflicts
          between mints.
        </p>
      ) : null}
      <dl className="outcomes">
        <Outcome name="Minted" value={outcomes.minted} tone="good" />
        <Outcome name="Sold out" value={outcomes.soldOut} />
        <Outcome name="Not included" value={outcomes.notIncluded} />
        <Outcome
          name="Failed"
          value={outcomes.failed}
          tone={outcomes.failed ? "bad" : undefined}
        />
        <Outcome name="Pending" value={outcomes.pending} />
      </dl>
      {blocks.length ? (
        <figure className="chart">
          <figcaption className="muted">Mints in each block</figcaption>
          <ol>
            {blocks.map((block) => (
              <li
                key={block.height}
                title={`Block ${block.height}: ${number(block.minted)} mints`}
              >
                <span
                  className="bar"
                  style={{
                    height: `${Math.max(2, (block.minted / tallest) * 100)}%`,
                  }}
                />
                <span className="mono value">{number(block.minted)}</span>
                <span className="mono label">#{block.height}</span>
              </li>
            ))}
          </ol>
        </figure>
      ) : null}
      <p className="muted">
        {number(blocks.length)} {blocks.length === 1 ? "block" : "blocks"} ·
        submitted over {seconds(rush.submitMs)} · settled after{" "}
        {seconds(rush.settledMs)}
        {conflicts.supply
          ? ` · ${number(conflicts.supply)} excluded at sell-out`
          : ""}
        {conflicts.funding
          ? ` · ${number(conflicts.funding)} excluded: the drop needs more storage funding`
          : ""}
      </p>
      {oneBlockEach ? (
        <p className="notice">
          Each mint landed in its own block, so this node makes one block for
          each transaction. Run setup:local again, or restart the node with{" "}
          <code>--block-driver interval --block-interval-ms 2000</code>.
        </p>
      ) : null}
      {rush.message ? <p role="alert">{rush.message}</p> : null}
    </div>
  );
}

function Outcome({
  name,
  value,
  tone,
}: {
  name: string;
  value: number;
  tone?: "good" | "bad" | undefined;
}) {
  return (
    <div data-tone={tone}>
      <dt className="muted">{name}</dt>
      <dd className="mono">{number(value)}</dd>
    </div>
  );
}
