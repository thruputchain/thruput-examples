import { createContext, useContext, useEffect, useRef, useState } from "react";
import { addressFromHex } from "@groundhogchain/client";
import {
  discoverWalletProviders,
  parseWalletSession,
  type WalletProvider,
} from "@groundhogchain/client/provider";
import { LaunchpadRoutes } from "@/app";
import type { AppConfig } from "@/config";
import { Button } from "@/components/ui/button";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { createReadClient } from "@/groundhog/client";
import { createProviderWriteBoundary } from "@/transactions/provider-wallet";
import { userErrorMessage } from "@/errors";

const WalletContext = createContext<{
  providers: WalletProvider[];
  address: string | undefined;
  busy: boolean;
  canDisconnect: boolean;
  error: string | null;
  connect(provider: WalletProvider): void;
  disconnect(): void;
} | null>(null);

export function ProviderApp({ base }: { base: AppConfig }) {
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [selected, setSelected] = useState<WalletProvider | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState<{
    config: AppConfig;
    writer: ReturnType<typeof createProviderWriteBoundary>;
    address: string;
    revision: number;
  } | null>(null);
  const active = useRef<ReturnType<typeof createProviderWriteBoundary> | null>(
    null,
  );
  const revision = useRef(0);
  useEffect(
    () =>
      discoverWalletProviders((provider) => {
        setProviders((current) =>
          current.some((entry) => entry.info.id === provider.info.id)
            ? current
            : [...current, provider],
        );
      }),
    [],
  );

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const update = (value: unknown) => {
      if (!live) return;
      active.current?.dispose();
      active.current = null;
      setBinding(null);
      const nextRevision = ++revision.current;
      try {
        const session = parseWalletSession(value);
        if (session.networkHash !== base.networkIdHex)
          throw new Error(
            "Switch your wallet to the configured launchpad network",
          );
        setError(null);
        const account = session.accounts[0];
        if (!account) return;
        const config = {
          ...base,
          accountAddress: addressFromHex(account.address),
        };
        const writer = createProviderWriteBoundary(
          config,
          createReadClient(config),
          selected,
          account,
        );
        active.current = writer;
        setBinding({
          config,
          writer,
          address: account.address,
          revision: nextRevision,
        });
        setError(null);
      } catch (reason) {
        setError(userErrorMessage(reason, "The wallet session is invalid"));
      }
    };
    let unsubscribe: () => void;
    try {
      unsubscribe = selected.on("change", (value) => {
        if (!live) return;
        active.current?.dispose();
        active.current = null;
        setBinding(null);
        const changed = ++revision.current;
        // Bind after event dispatch: providers may iterate a live listener set.
        queueMicrotask(() => {
          if (live && revision.current === changed) update(value);
        });
      });
      if (typeof unsubscribe !== "function")
        throw new Error("Wallet subscription is unavailable");
    } catch (reason) {
      setError(userErrorMessage(reason, "Wallet subscription failed"));
      setBusy(false);
      return () => {
        live = false;
      };
    }
    const started = revision.current;
    setBusy(true);
    void Promise.resolve()
      .then(() => selected.request({ method: "connect" }))
      .then((value) => {
        if (live && revision.current === started) update(value);
      })
      .catch((reason: unknown) => {
        if (live && revision.current === started)
          setError(userErrorMessage(reason, "Wallet connection failed"));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      unsubscribe();
      active.current?.dispose();
      active.current = null;
    };
  }, [selected, base, connectionAttempt]);

  async function disconnect() {
    const provider = selected;
    active.current?.dispose();
    active.current = null;
    const disconnected = ++revision.current;
    setBinding(null);
    setSelected(null);
    setBusy(false);
    setError(null);
    try {
      await provider?.request({ method: "disconnect" });
    } catch (reason) {
      if (revision.current === disconnected)
        setError(
          userErrorMessage(
            reason,
            "Wallet disconnect failed; local access was removed",
          ),
        );
    }
  }
  return (
    <WalletContext
      value={{
        providers,
        address: binding?.address,
        busy,
        canDisconnect: selected !== null,
        error,
        connect(provider) {
          ++revision.current;
          active.current?.dispose();
          active.current = null;
          setBinding(null);
          setError(null);
          setSelected(provider);
          setConnectionAttempt((value) => value + 1);
        },
        disconnect: () => {
          void disconnect();
        },
      }}
    >
      <LaunchpadRoutes
        key={
          binding ? `${binding.address}:${binding.revision}` : "disconnected"
        }
        config={binding?.config ?? base}
        {...(binding ? { writer: binding.writer } : {})}
        readOnly={!binding}
      />
    </WalletContext>
  );
}

export function WalletControls() {
  const wallet = useContext(WalletContext);
  if (!wallet) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label="Wallet connection"
    >
      {wallet.address ? (
        <BlockchainIdentifier value={wallet.address} kind="address" />
      ) : (
        <>
          {wallet.providers.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              Install a Groundhog wallet to connect
            </span>
          ) : (
            wallet.providers.map((provider) => (
              <Button
                key={provider.info.id}
                disabled={wallet.busy}
                onClick={() => wallet.connect(provider)}
              >
                Connect {provider.info.name}
              </Button>
            ))
          )}
        </>
      )}
      {wallet.canDisconnect ? (
        <Button variant="outline" onClick={wallet.disconnect}>
          Disconnect
        </Button>
      ) : null}
      {wallet.error ? (
        <p role="alert" className="text-sm text-destructive">
          {wallet.error}
        </p>
      ) : null}
    </div>
  );
}
