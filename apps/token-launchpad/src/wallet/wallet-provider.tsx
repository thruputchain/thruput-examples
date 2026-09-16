import { useEffect, useRef, useState, type ReactNode } from "react";
import { addressFromHex } from "@groundhogchain/client";
import {
  discoverWalletProviders,
  parseWalletSession,
  type WalletProvider as Provider,
  type WalletSession,
} from "@groundhogchain/client/provider";
import { createProviderWalletClient } from "@groundhogchain/client/wallet";
import { publicConfigKey, type AppConfig } from "@/config";
import { createReadClient } from "@/groundhog/client";
import { createProviderWriteBoundary } from "@/transactions/provider-wallet";
import { userErrorMessage } from "@/errors";
import { WalletWriteContext } from "./write-context";
import { WalletContext } from "./use-wallet";

interface WalletProviderProps {
  config: AppConfig;
  children: (
    config: AppConfig,
    connected: boolean,
    hasWalletAccount: boolean,
  ) => ReactNode;
}

export function WalletProvider(props: WalletProviderProps) {
  return <WalletRuntime key={publicConfigKey(props.config)} {...props} />;
}

function WalletRuntime({
  config: initialConfig,
  children,
}: WalletProviderProps) {
  const [base] = useState(initialConfig);
  const [client] = useState(() => createReadClient(base));
  const [readOnlyWriter] = useState(() =>
    createProviderWriteBoundary(base, client),
  );
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [binding, setBinding] = useState<{
    config: AppConfig;
    writer: ReturnType<typeof createProviderWriteBoundary>;
    address: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<ReturnType<typeof createProviderWriteBoundary> | null>(
    null,
  );
  const revision = useRef(0);
  const accepting = useRef(false);
  const selectedAddress = useRef<string | undefined>(undefined);
  const lastConfig = useRef(base);

  function invalidate() {
    revision.current++;
    active.current?.dispose();
    active.current = null;
    setBinding(null);
  }
  function activate(
    value: unknown,
    source: Provider,
    address = selectedAddress.current,
  ) {
    invalidate();
    const next = parseWalletSession(value);
    setSession(next);
    if (next.networkHash !== base.networkIdHex)
      throw new Error("Switch your wallet to the configured launchpad network");
    const account =
      next.accounts.find((a) => a.address === address) ?? next.accounts[0];
    if (!account) return;
    const config =
      selectedAddress.current === account.address
        ? lastConfig.current
        : { ...base, accountAddress: addressFromHex(account.address) };
    const wallet = createProviderWalletClient({
      client,
      provider: source,
      account,
      networkHash: next.networkHash,
    });
    const writer = createProviderWriteBoundary(config, client, wallet, () => {
      // An old request must not disconnect a newer wallet binding.
      if (active.current !== writer) return;
      invalidate();
      setSession(null);
      setBusy(false);
    });
    lastConfig.current = config;
    selectedAddress.current = account.address;
    active.current = writer;
    setBinding({
      config,
      writer,
      address: account.address,
    });
  }
  useEffect(
    () =>
      discoverWalletProviders((entry) => {
        setProviders((current) =>
          current.some((p) => p.info.id === entry.info.id)
            ? current
            : [...current, entry],
        );
        setProvider((current) => current ?? entry);
      }),
    [],
  );
  useEffect(() => {
    if (!provider) return;
    try {
      const unsubscribe = provider.on("change", (value) => {
        if (!accepting.current) return;
        invalidate();
        setSession(null);
        setBusy(false);
        setError(null);
        const changed = revision.current;
        queueMicrotask(() => {
          if (revision.current !== changed) return;
          try {
            activate(value, provider);
          } catch (error) {
            setError(userErrorMessage(error, "Wallet session is invalid"));
          }
        });
      });
      if (typeof unsubscribe !== "function")
        throw new Error("Wallet subscription is unavailable");
      return unsubscribe;
    } catch (error) {
      invalidate();
      setBusy(false);
      setError(userErrorMessage(error, "Wallet subscription failed"));
    }
  }, [provider]);
  useEffect(
    () => () => {
      accepting.current = false;
      revision.current++;
      active.current?.dispose();
    },
    [],
  );

  async function connect() {
    if (!provider || busy) return;
    accepting.current = true;
    setBusy(true);
    setError(null);
    const started = revision.current;
    try {
      const value = await provider.request({ method: "connect" });
      if (started === revision.current) {
        setBusy(false);
        try {
          activate(value, provider);
        } catch (error) {
          setError(userErrorMessage(error, "Wallet session is invalid"));
        }
      }
    } catch (error) {
      if (started === revision.current) {
        setBusy(false);
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === 4001 &&
          error.message === "Page closed"
        )
          return;
        setError(userErrorMessage(error, "Wallet connection failed"));
      }
    }
  }
  async function disconnect() {
    accepting.current = false;
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
    <WalletWriteContext value={binding?.writer ?? readOnlyWriter}>
      <WalletContext
        value={{
          providers,
          provider,
          session,
          address: binding?.address ?? null,
          busy,
          error,
          connect,
          disconnect,
          selectProvider(id) {
            accepting.current = false;
            invalidate();
            setSession(null);
            setError(null);
            selectedAddress.current = undefined;
            setProvider(providers.find((p) => p.info.id === id) ?? null);
          },
          selectAccount(address) {
            if (provider && session) {
              try {
                activate(session, provider, address);
              } catch (error) {
                setError(userErrorMessage(error, "Account selection failed"));
              }
            }
          },
        }}
      >
        {children(
          binding?.config ?? lastConfig.current,
          !!binding,
          lastConfig.current !== base,
        )}
      </WalletContext>
    </WalletWriteContext>
  );
}
