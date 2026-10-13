import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider, useWallet } from "@thruputchain/react";
import { AppHeader } from "./components/app-header";
import { BlockchainIdentifier } from "./components/blockchain-identifier";
import { CounterDisplay } from "./components/counter-display";
import { CounterControls } from "./components/counter-controls";
import { KeyboardPad } from "./components/keyboard-pad";
import { SessionActivity } from "./components/session-activity";
import { errorMessage, parseConfig, type AppConfig } from "./config";
import type { Direction, Snapshot } from "./transactions/engine";
import { useCounter } from "./transactions/use-counter";
import { createPublicClient } from "./thruput/public-client";
import { useCounterValue } from "./thruput/use-counter-value";
import { useSigningMode, type SigningMode } from "./wallet/use-signing-mode";
import { useWalletCounter } from "./wallet/use-wallet-counter";
import { WalletControls } from "./wallet/wallet-controls";
import { WalletActivity } from "./wallet/wallet-activity";

type Runtime = {
  config: AppConfig;
  client: Awaited<ReturnType<typeof createPublicClient>>;
  queries: QueryClient;
};

export function App() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [message, setMessage] = useState("Connecting to Thruput…");
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
  const wallet = useWallet();
  const activity = useWalletCounter(config.counterAddress);
  const signing = useSigningMode(
    Boolean(activity.pending.record || activity.pending.error),
  );
  const development = useCounter(
    config,
    signing.mode === "development" && !signing.busy,
  );
  const counter = useCounterValue(config.counterAddress);
  const walletMode = signing.mode === "wallet";
  const canSend =
    !signing.busy &&
    (walletMode
      ? wallet.status === "connected" && !activity.blocked
      : Boolean(config.signerAddress) && development.snapshot.ready);
  const message =
    counter.error?.message ??
    (walletMode
      ? activity.blocked
        ? "Resolve the current wallet update before sending another."
        : "Connect a wallet on this network, or disconnect to use the development signer."
      : config.signerAddress
        ? development.snapshot.message
        : "Connect a wallet to send updates. No development signer is configured.");
  const snapshot = {
    ...development.snapshot,
    value: counter.data?.value ?? null,
    ready: Boolean(counter.data) && !counter.error && canSend,
    atCapacity: !walletMode && development.snapshot.atCapacity,
    message,
  };
  return (
    <CounterPage
      config={config}
      snapshot={snapshot}
      send={walletMode ? activity.send : development.send}
      signing={{
        mode: signing.mode,
        address: walletMode ? wallet.address : config.signerAddress,
      }}
      walletControls={
        <WalletControls mode={signing.mode} disconnect={signing.disconnect} />
      }
      walletActivity={
        <WalletActivity activity={activity} explorerUrl={config.explorerUrl} />
      }
      readStale={Boolean(counter.error)}
    />
  );
}

export function CounterPage({
  config,
  snapshot,
  send,
  signing = { mode: "development", address: config?.signerAddress ?? null },
  walletControls,
  walletActivity,
  readStale = !snapshot.ready,
}: {
  config: AppConfig | null;
  snapshot: Snapshot;
  send(direction: Direction): void;
  signing?: { mode: SigningMode; address: string | null };
  walletControls?: ReactNode;
  walletActivity?: ReactNode;
  readStale?: boolean;
}) {
  const development = signing.mode === "development";
  const disabled = !snapshot.ready || snapshot.atCapacity;
  return (
    <>
      <AppHeader
        ready={snapshot.ready}
        canTopup={development && Boolean(config?.signerAddress)}
        signerBalance={snapshot.signerBalance}
      />
      <main className="py-10 sm:py-14">
        <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 sm:px-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-3xl tracking-tight sm:text-4xl">
              Every key counts
            </h1>
            <p className="max-w-[56ch] text-base text-muted-foreground">
              A shared counter. Use the development signer or connect your
              wallet.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <p role="status">
              {development
                ? "Using development signer"
                : "Using connected wallet"}
              {signing.address ? (
                <>
                  :{" "}
                  <BlockchainIdentifier
                    value={signing.address}
                    kind="address"
                    explorerUrl={config?.explorerUrl ?? null}
                  />
                </>
              ) : (
                " (unavailable)"
              )}
            </p>
            {walletControls}
          </div>
          {!snapshot.ready ? (
            <p role="status" className="rounded-md border bg-card p-4">
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
          {walletActivity}
          <details open className="flex flex-col gap-6">
            <summary className="cursor-pointer text-lg">
              Development signer activity
            </summary>
            {development ? (
              <KeyboardPad disabled={disabled} onInput={send} />
            ) : (
              <p className="py-4">
                Keyboard transactions are available with the development signer.
                Previously submitted transactions are still being checked.
              </p>
            )}
            <SessionActivity
              snapshot={snapshot}
              explorerUrl={config?.explorerUrl ?? null}
            />
          </details>
          {config ? (
            <p className="border-t pt-6">
              Counter{" "}
              <BlockchainIdentifier
                value={config.counterAddress}
                kind="address"
                explorerUrl={config.explorerUrl}
              />
            </p>
          ) : null}
        </div>
      </main>
    </>
  );
}
