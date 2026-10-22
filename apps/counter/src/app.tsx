import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "@thruputchain/react";
import { AppHeader } from "./components/app-header";
import { CounterDisplay } from "./components/counter-display";
import { CounterControls } from "./components/counter-controls";
import { KeyboardPad } from "./components/keyboard-pad";
import { SessionActivity } from "./components/session-activity";
import { errorMessage, parseConfig, type AppConfig } from "./config";
import type { Direction, Snapshot } from "./transactions/engine";
import { useCounter } from "./transactions/use-counter";
import { createPublicClient } from "./thruput/public-client";
import { useCounterValue } from "./thruput/use-counter-value";

type Runtime = {
  config: AppConfig;
  client: Awaited<ReturnType<typeof createPublicClient>>;
  queries: QueryClient;
};

export function App() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function start() {
      try {
        const response = await fetch("/api/config", {
          signal: controller.signal,
        });
        const body: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            errorMessage(body, "Could not load Counter configuration."),
          );
        const config = parseConfig(body);
        const client = await createPublicClient(
          config,
          new URL("/thruput-rpc", location.origin).href,
        );
        if (!controller.signal.aborted)
          setRuntime({ config, client, queries: new QueryClient() });
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(errorMessage(error));
          timer = setTimeout(start, 2_000);
        }
      }
    }
    void start();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  if (!runtime && !message) return null;
  if (!runtime)
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p role="status">{message}</p>
        <p>Node connections retry automatically.</p>
      </main>
    );
  return (
    <QueryClientProvider client={runtime.queries}>
      <WalletProvider client={runtime.client}>
        <ConnectedCounter
          key={`${runtime.config.networkId}:${runtime.config.counterAddress}`}
          config={runtime.config}
        />
      </WalletProvider>
    </QueryClientProvider>
  );
}

export function ConnectedCounter({ config }: { config: AppConfig }) {
  const development = useCounter(config, true);
  const counter = useCounterValue(config.counterAddress);
  const canSend = Boolean(config.signerAddress) && development.snapshot.ready;
  const message =
    counter.error?.message ??
    (config.signerAddress
      ? development.snapshot.message
      : "No development signer is configured. Run Counter setup to send updates.");
  const snapshot = {
    ...development.snapshot,
    value: counter.data?.value ?? null,
    ready: Boolean(counter.data) && !counter.error && canSend,
    message,
  };
  return (
    <CounterPage
      config={config}
      snapshot={snapshot}
      send={development.send}
      readStale={Boolean(counter.error)}
    />
  );
}

export function CounterPage({
  config,
  snapshot,
  send,
  readStale = !snapshot.ready,
}: {
  config: AppConfig | null;
  snapshot: Snapshot;
  send(direction: Direction): void;
  readStale?: boolean;
}) {
  const disabled = !snapshot.ready || snapshot.atCapacity;
  return (
    <>
      <AppHeader
        canTopup={Boolean(config?.signerAddress)}
        signerBalance={snapshot.signerBalance}
      />
      <main className="py-10 sm:py-14">
        <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 sm:px-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-3xl tracking-tight sm:text-4xl">
              Every key counts
            </h1>
            <p className="max-w-[56ch] text-base text-muted-foreground">
              A shared counter. One key. One transaction. No wallet prompts.
            </p>
          </div>
          {!snapshot.ready && snapshot.message ? (
            <p role="alert" className="rounded-md border bg-card p-4">
              {snapshot.message}
            </p>
          ) : null}
          <section
            aria-label="Counter controls"
            className="flex flex-col gap-6"
          >
            <CounterDisplay value={snapshot.value} stale={readStale} />
            <CounterControls
              disabled={disabled}
              value={snapshot.value}
              send={send}
            />
            {snapshot.atCapacity ? (
              <p role="status">
                At capacity. Wait for pending transactions before sending more.
              </p>
            ) : null}
          </section>
          <div className="flex flex-col gap-6">
            <KeyboardPad disabled={disabled} onInput={send} />
            <SessionActivity
              snapshot={snapshot}
              explorerUrl={config?.explorerUrl ?? null}
            />
          </div>
        </div>
      </main>
    </>
  );
}
