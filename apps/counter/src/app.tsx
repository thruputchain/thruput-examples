import { MinusIcon, PlusIcon } from "lucide-react";
import { AppHeader } from "./components/app-header";
import { BlockchainIdentifier } from "./components/blockchain-identifier";
import { KeyboardPad } from "./components/keyboard-pad";
import { SessionActivity } from "./components/session-activity";
import type { AppConfig } from "./config";
import type { Direction, Snapshot } from "./transactions/engine";
import { useCounter } from "./transactions/use-counter";

export function App() {
  return <CounterPage {...useCounter()} />;
}

export function CounterPage({
  config,
  snapshot,
  send,
}: {
  config: AppConfig | null;
  snapshot: Snapshot;
  send(direction: Direction): void;
}) {
  const disabled = !snapshot.ready || snapshot.atCapacity;
  const value = snapshot.value?.toLocaleString("en-US") ?? "—";
  return (
    <>
      <AppHeader ready={snapshot.ready} />
      <main className="py-10 sm:py-14">
        <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 sm:px-6">
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl tracking-tight sm:text-4xl">
              Every key counts
            </h1>
            <p className="max-w-[56ch] text-base text-muted-foreground">
              A shared counter. Real transactions. See Groundhog keep up.
            </p>
          </div>
          {!snapshot.ready ? (
            <div
              role="status"
              className="flex flex-col gap-3 rounded-md border bg-card p-4 text-base sm:text-sm"
            >
              <p>{snapshot.message}</p>
              {snapshot.message !== "Connecting to Groundhog…" ? (
                <p className="text-muted-foreground">
                  Node connections retry automatically. After changing
                  configuration,{" "}
                  <button
                    className="underline underline-offset-4 hover:text-foreground"
                    onClick={() => window.location.reload()}
                  >
                    reload the session
                  </button>
                  .
                </p>
              ) : null}
            </div>
          ) : null}
          <section
            aria-label="Counter controls"
            className="flex flex-col gap-6"
          >
            <div className="flex flex-col items-center gap-4 py-6 sm:py-10">
              <p className="font-mono text-sm text-muted-foreground">
                Latest chain value
                {!snapshot.ready && snapshot.value !== null ? " · stale" : ""}
              </p>
              <div
                data-testid="counter-value"
                className={`max-w-full break-all text-center font-mono font-medium tracking-tight tabular-nums ${value.length > 14 ? "text-2xl sm:text-4xl" : "text-4xl sm:text-6xl md:text-7xl"}`}
              >
                {value}
              </div>
              <p className="text-base text-muted-foreground sm:text-sm">
                Shared by everyone. Updated from the chain.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                className="counter-button border-border bg-secondary hover:bg-accent"
                disabled={disabled || snapshot.value === 0n}
                onClick={() => send("decrement")}
              >
                <MinusIcon aria-hidden="true" className="size-6 shrink-0" />{" "}
                Decrement
              </button>
              <button
                className="counter-button border-primary bg-primary text-primary-foreground hover:bg-primary-hover"
                disabled={disabled}
                onClick={() => send("increment")}
              >
                <PlusIcon aria-hidden="true" className="size-6 shrink-0" />{" "}
                Increment
              </button>
            </div>
            {snapshot.atCapacity ? (
              <p
                role="status"
                className="text-base text-muted-foreground sm:text-sm"
              >
                At capacity. Wait for pending transactions before sending more.
              </p>
            ) : null}
            <KeyboardPad disabled={disabled} onInput={send} />
          </section>
          <SessionActivity
            snapshot={snapshot}
            explorerUrl={config?.explorerUrl ?? null}
          />
          <div className="flex flex-col gap-2 border-t pt-6 text-base text-muted-foreground sm:text-sm">
            {config ? (
              <p>
                Counter{" "}
                <BlockchainIdentifier
                  value={config.counterAddress}
                  kind="address"
                  explorerUrl={config.explorerUrl}
                />
              </p>
            ) : null}
            <p>
              Signed with a development key and test HOG. Session counts reset
              when you reload; the shared counter keeps going.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
