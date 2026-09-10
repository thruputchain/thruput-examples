import { addressFromHex, toHex0x } from "@groundhogchain/client";
import {
  discoverWalletProviders,
  parseWalletSession,
  type WalletProvider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import {
  createProviderWalletClient,
  type ProviderWalletClient,
} from "@groundhogchain/client/wallet";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { READ_ONLY_CALLER, type GlobalConfig } from "@/config";
import { createReadClient } from "@/groundhog/client";
import { createProviderWriteBoundary } from "@/transactions/provider-wallet";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { WalletWriteContext } from "./write-context";

export function ConnectedWalletApp({
  config,
  children,
}: {
  config: GlobalConfig;
  children: (
    config: GlobalConfig,
    connected: boolean,
    revision: number,
  ) => React.ReactNode;
}) {
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [client] = useState(() => createReadClient(config));
  const [session, setSession] = useState<WalletSession | null>(null);
  const [runtime, setRuntime] = useState<{
    config: GlobalConfig;
    writer: WriteBoundary;
    connected: boolean;
    revision: number;
  }>(() => ({
    config: { ...config, accountAddress: READ_ONLY_CALLER },
    writer: createProviderWriteBoundary(config, client),
    connected: false,
    revision: 0,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const binding = useRef<ProviderWalletClient | null>(null);
  const generation = useRef(0);
  const acceptingChanges = useRef(false);
  const selectedAddress = useRef<string | undefined>(undefined);

  function invalidate() {
    generation.current += 1;
    binding.current?.dispose();
    binding.current = null;
    setRuntime((previous) => ({
      config: { ...config, accountAddress: READ_ONLY_CALLER },
      writer: createProviderWriteBoundary(config, client),
      connected: false,
      revision: previous.revision + 1,
    }));
  }

  function activate(
    value: unknown,
    selectedProvider: WalletProvider,
    address?: string,
  ) {
    invalidate();
    const next = parseWalletSession(value);
    setSession(next);
    if (next.networkHash !== config.networkIdHex)
      throw new Error("Switch the wallet to this app's Groundhog network");
    const account =
      next.accounts.find((entry) => entry.address === address) ??
      next.accounts[0];
    if (!account) return;
    selectedAddress.current = account.address;
    const connectedConfig = {
      ...config,
      accountAddress: addressFromHex(account.address),
    };
    const wallet = createProviderWalletClient({
      client,
      provider: selectedProvider,
      account,
      networkHash: next.networkHash,
    });
    binding.current = wallet;
    setRuntime((previous) => ({
      config: connectedConfig,
      writer: createProviderWriteBoundary(connectedConfig, client, wallet),
      connected: true,
      revision: previous.revision + 1,
    }));
  }

  useEffect(
    () =>
      discoverWalletProviders((entry) => {
        setProviders((previous) =>
          previous.some((item) => item.info.id === entry.info.id)
            ? previous
            : [...previous, entry],
        );
        setProvider((previous) => previous ?? entry);
      }),
    [],
  );
  useEffect(() => {
    if (!provider) return;
    try {
      const unsubscribe = provider.on("change", (value) => {
        if (!acceptingChanges.current) return;
        invalidate();
        setSession(null);
        setBusy(false);
        setError(null);
        const change = generation.current;
        // Bind after event dispatch, so this event cannot invalidate the new adapter.
        queueMicrotask(() => {
          if (change !== generation.current) return;
          try {
            activate(value, provider, selectedAddress.current);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Wallet session is invalid",
            );
          }
        });
      });
      if (typeof unsubscribe !== "function")
        throw new Error("Wallet change subscription is unavailable");
      return unsubscribe;
    } catch (failure) {
      invalidate();
      setError(
        failure instanceof Error
          ? failure.message
          : "Wallet change subscription failed",
      );
    }
  }, [provider, config]);
  useEffect(
    () => () => {
      generation.current += 1;
      acceptingChanges.current = false;
      binding.current?.dispose();
    },
    [],
  );

  async function connect() {
    if (!provider || busy) return;
    setBusy(true);
    setError(null);
    acceptingChanges.current = true;
    const attempt = generation.current;
    try {
      const value = await provider.request({ method: "connect" });
      if (attempt === generation.current) {
        setBusy(false);
        try {
          activate(value, provider);
        } catch (failure) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Wallet session is invalid",
          );
        }
      }
    } catch (failure) {
      if (attempt === generation.current) {
        setBusy(false);
        setError(
          failure instanceof Error
            ? failure.message
            : "Wallet connection failed",
        );
      }
    }
  }

  async function disconnect() {
    acceptingChanges.current = false;
    invalidate();
    setSession(null);
    setError(null);
    setBusy(true);
    try {
      await provider?.request({ method: "disconnect" });
    } catch {
      setError(
        "Disconnected locally. The wallet could not confirm permission revocation.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <WalletWriteContext value={runtime.writer}>
      <section
        aria-label="Wallet connection"
        className="flex flex-wrap items-center justify-end gap-3 border-b bg-background px-4 py-3 text-foreground"
      >
        {providers.length > 1 ? (
          <label className="flex items-center gap-2">
            Wallet
            <select
              className="max-w-48 rounded-md border border-input bg-background px-2 py-1 text-sm"
              aria-label="Wallet provider"
              disabled={busy}
              value={provider?.info.id ?? ""}
              onChange={(event) => {
                acceptingChanges.current = false;
                selectedAddress.current = undefined;
                invalidate();
                setSession(null);
                setError(null);
                setProvider(
                  providers.find(
                    (entry) => entry.info.id === event.target.value,
                  ) ?? null,
                );
              }}
            >
              {providers.map((entry) => (
                <option key={entry.info.id} value={entry.info.id}>
                  {entry.info.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {runtime.connected ? (
          <>
            <label className="flex items-center gap-2">
              Account
              <select
                className="max-w-48 rounded-md border border-input bg-background px-2 py-1 text-sm"
                aria-label="Wallet account"
                value={toHex0x(runtime.config.accountAddress)}
                onChange={(event) => {
                  try {
                    if (provider && session)
                      activate(session, provider, event.target.value);
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Account selection failed",
                    );
                  }
                }}
              >
                {session?.accounts.map((account) => (
                  <option key={account.address} value={account.address}>
                    {account.address.slice(0, 10)}...{account.address.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
            <BlockchainIdentifier
              value={toHex0x(runtime.config.accountAddress)}
              label="Connected account"
              kind="address"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <span>Read-only browsing</span>
            {providers.length === 0 ? <span>No wallet found</span> : null}
            <Button
              size="sm"
              disabled={!provider || busy}
              onClick={() => void connect()}
            >
              {busy
                ? "Connecting..."
                : provider
                  ? `Connect ${provider.info.name}`
                  : "Connect wallet"}
            </Button>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </section>
      {children(runtime.config, runtime.connected, runtime.revision)}
    </WalletWriteContext>
  );
}
