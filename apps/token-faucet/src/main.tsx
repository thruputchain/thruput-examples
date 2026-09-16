import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ZapIcon } from "lucide-react";
import {
  discoverWalletProviders,
  parseWalletSession,
  type WalletProvider,
} from "@groundhogchain/client/provider";
import {
  canonicalAddress,
  type ClaimStatus,
  type FaucetManifest,
} from "./domain";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "./styles.css";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "The faucet is unavailable.",
    );
  return body as T;
}

function App() {
  const [config, setConfig] = useState<FaucetManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<FaucetManifest>("/api/config", { signal: controller.signal })
      .then(setConfig)
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The faucet could not load. Refresh this page to retry.");
      });
    return () => controller.abort();
  }, []);
  return config ? (
    <Faucet config={config} />
  ) : (
    <AppShell>
      <p role={error ? "alert" : "status"}>{error ?? "Loading faucet…"}</p>
    </AppShell>
  );
}

function AppShell({
  actions,
  children,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="header">
        <div className="container header-content">
          <a
            href="/"
            aria-label="Thruput Token Faucet homepage"
            className="brand"
          >
            <ZapIcon className="brand-icon" aria-hidden="true" />
            <div className="brand-labels">
              <div className="brand-name">THRUPUT</div>
              <div className="brand-product">Token Faucet</div>
            </div>
          </a>
          <div className="header-actions">
            <p className="network">Devnet</p>
            {actions ?? (
              <button type="button" disabled>
                Connect Wallet
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="container">
        <section className="intro">
          <h1>Token faucet</h1>
          <p>
            Get test tokens in your wallet, then try a swap. Each address can
            receive 10 of each token, once.
          </p>
        </section>
        {children}
      </main>
    </div>
  );
}

function Faucet({ config }: { config: FaucetManifest }) {
  const [address, setAddress] = useState("");
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<{
    address: string;
    claims: Record<string, ClaimStatus>;
  } | null>(null);
  let recipient: string | null = null;
  try {
    recipient = canonicalAddress(address.trim());
  } catch {
    /* Incomplete input. */
  }
  const claims = results?.address === recipient ? results.claims : null;
  const provider =
    providers.find((entry) => entry.info.id === providerId) ?? providers[0];
  useEffect(
    () =>
      discoverWalletProviders((entry) => {
        setProviders((current) =>
          current.some((item) => item.info.id === entry.info.id)
            ? current
            : [...current, entry],
        );
      }),
    [],
  );
  useEffect(() => {
    setResults(null);
    if (!recipient) return;
    const controller = new AbortController();
    const current = recipient;
    void api<Record<string, ClaimStatus>>(`/api/claims?address=${recipient}`, {
      signal: controller.signal,
    })
      .then((claims) =>
        setResults((previous) => ({
          address: current,
          claims: {
            ...claims,
            ...(previous?.address === current ? previous.claims : {}),
          },
        })),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Could not check previous claims. You can retry a claim safely.",
          );
      });
    return () => controller.abort();
  }, [recipient]);

  async function connectWallet() {
    if (!provider || busy) return;
    setBusy("wallet");
    setError(null);
    try {
      const session = parseWalletSession(
        await provider.request({ method: "connect" }),
      );
      if (
        session.networkHash.replace(/^0x/, "") !==
        config.network.replace(/^0x/, "")
      )
        throw new Error("Switch your wallet to this faucet's devnet.");
      const account = session.accounts[0];
      if (!account) throw new Error("Choose an account in your wallet.");
      setAddress(account.address);
      setMessage("Wallet address copied. Check the recipient before claiming.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Wallet connection failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function claim(tokens: string[]) {
    if (!recipient || busy) return;
    setError(null);
    setMessage(null);
    const current = recipient;
    try {
      for (const token of tokens) {
        if (claims?.[token]?.state === "claimed") continue;
        setBusy(token);
        const status = await api<ClaimStatus>("/api/claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, address: current }),
        });
        setResults((previous) => ({
          address: current,
          claims: {
            ...(previous?.address === current ? previous.claims : {}),
            [token]: status,
          },
        }));
      }
      setMessage("Tokens received. Your wallet is ready to try a swap.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Claim failed. Please retry.",
      );
    } finally {
      setBusy(null);
    }
  }
  const remaining = config.tokens.filter(
    (token) => claims?.[token.address]?.state !== "claimed",
  );
  return (
    <AppShell
      actions={
        <section className="wallet-controls" aria-label="Wallet connection">
          {providers.length > 1 ? (
            <select
              name="wallet"
              aria-label="Wallet provider"
              value={provider?.info.id}
              disabled={busy !== null}
              onChange={(event) => setProviderId(event.target.value)}
            >
              {providers.map((entry) => (
                <option key={entry.info.id} value={entry.info.id}>
                  {entry.info.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={!provider || busy !== null}
            title={
              !provider
                ? "Install or enable Thruput Wallet to connect"
                : undefined
            }
            onClick={() => void connectWallet()}
          >
            {busy === "wallet" ? "Connecting…" : "Connect Wallet"}
          </button>
        </section>
      }
    >
      <div className="faucet-layout">
        <section className="claim-panel" aria-labelledby="recipient-title">
          <div className="section-heading">
            <h2 id="recipient-title">1. Choose your wallet</h2>
            <p>Transfers go to the address below. No signature is needed.</p>
          </div>
          <label htmlFor="address">Recipient address</label>
          <input
            id="address"
            name="address"
            placeholder="0x…"
            value={address}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="address-help"
            onChange={(event) => {
              setAddress(event.target.value);
              setError(null);
              setMessage(null);
            }}
          />
          <p id="address-help" className="muted">
            Paste your devnet address or use a connected wallet.
          </p>
          <div className="next-step">
            <h2>Next stop: Swap</h2>
            <p>
              Open Swap to trade or create a pool with your tokens. Keep some
              native HOG for transaction capacity and pool creation.
            </p>
            <a href={config.swapUrl}>Open Swap →</a>
          </div>
        </section>
        <section aria-labelledby="tokens-title" className="tokens-panel">
          <div className="section-heading">
            <h2 id="tokens-title">2. Get your test tokens</h2>
            <p>10 per token. One claim per address.</p>
          </div>
          <ul role="list" className="tokens">
            {config.tokens.map((token) => {
              const status = claims?.[token.address];
              const claimed = status?.state === "claimed";
              return (
                <li key={token.address}>
                  <div className="token-mark" aria-hidden="true">
                    {token.symbol.slice(0, 1)}
                  </div>
                  <div className="token-description">
                    <h3>{token.symbol}</h3>
                    <p>{token.name}</p>
                    {status?.transactionHash ? (
                      <p className="receipt">
                        <a
                          href={`${config.explorerUrl}/tx/${status.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {claimed ? "View transfer" : "View pending transfer"}{" "}
                          ↗
                        </a>
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={!recipient || busy !== null || claimed}
                    onClick={() => void claim([token.address])}
                  >
                    {busy === token.address
                      ? "Sending…"
                      : claimed
                        ? "Claimed"
                        : status?.state === "pending"
                          ? "Check claim"
                          : `Get 10 ${token.symbol}`}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="primary"
            disabled={!recipient || busy !== null || remaining.length === 0}
            onClick={() => void claim(remaining.map((token) => token.address))}
          >
            {busy && busy !== "wallet"
              ? "Sending tokens…"
              : remaining.length === 0
                ? "All tokens claimed"
                : "Get all available tokens"}
          </button>
          <div className="feedback" aria-live="polite">
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : message ? (
              <p>{message}</p>
            ) : (
              <p className="muted">
                Test tokens are transferred from the faucet's existing supply.
              </p>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
