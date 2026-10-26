import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Droplets, ExternalLink } from "lucide-react";
import { formatUnits } from "@thruputchain/client";
import { address, type Claim, type PublicConfig } from "../shared/config";

type Config = PublicConfig & { available: boolean };
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/${path}`, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json().catch(() => {
    throw new Error(
      "Faucet is unavailable. Keep your saved claim and try again later.",
    );
  });
  if (!response.ok)
    throw new ApiError(
      value.error ||
        "Request failed. Check your saved claim before trying again.",
      response.status,
    );
  return value as T;
}
interface Saved {
  id: string;
  recipient: string;
}
function Faucet({ config }: { config: Config }) {
  const queryClient = useQueryClient();
  const key = `token-faucet:${config.networkId}:${config.anchorHash}`;
  const [recipient, setRecipient] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const value = JSON.parse(raw) as Saved;
        if (typeof value.id !== "string" || typeof value.recipient !== "string")
          throw new Error("Invalid saved claim.");
        address(value.recipient);
        setSaved(value);
        setRecipient(value.recipient);
      }
      setStorageReady(true);
    } catch {
      setError(
        "Cannot read saved claim data. Restore browser storage before claiming.",
      );
    }
  }, [key]);
  const status = useQuery({
    queryKey: [key, saved?.id],
    queryFn: () => request<Claim>(`claims/${saved!.id}`),
    enabled: !!saved,
    refetchInterval: (query) =>
      query.state.data?.status === "confirmed" ||
      query.state.data?.status === "failed"
        ? false
        : 5_000,
  });
  async function claim() {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const value = saved || {
        id: crypto.randomUUID(),
        recipient: address(recipient.trim()),
      };
      localStorage.setItem(key, JSON.stringify(value)); // Save before the request can reach the server.
      setSaved(value);
      const accepted = await request<Claim>("claims", {
        ...value,
        networkId: config.networkId,
        anchorHash: config.anchorHash,
      });
      if (accepted.recipient !== value.recipient)
        throw new Error("Claim recipient mismatch. Keep your saved claim ID.");
      // A second tab may discover an existing pending claim for this address.
      const canonical = { id: accepted.id, recipient: accepted.recipient };
      localStorage.setItem(key, JSON.stringify(canonical));
      setSaved(canonical);
      queryClient.setQueryData([key, accepted.id], accepted);
    } catch (error) {
      // A new request rejected before reservation has no payout to recover.
      // Keep existing IDs and all uncertain outcomes, including server errors.
      if (
        !saved &&
        error instanceof ApiError &&
        [400, 403, 415, 429].includes(error.status)
      ) {
        try {
          localStorage.removeItem(key);
          setSaved(null);
        } catch {
          // Retain the saved ID if browser storage cannot be updated.
        }
      }
      setError(error instanceof Error ? error.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }
  const result = status.data;
  const terminal =
    result?.status === "confirmed" || result?.status === "failed";
  return (
    <main>
      <div className="layout">
        <section className="panel">
          <div className="section-title">
            <Droplets size={22} aria-hidden="true" />
            <h1>Claim test tokens</h1>
          </div>
          <p className="muted">
            These tokens have no monetary value. Native-token funding is
            separate.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void claim();
            }}
          >
            <label htmlFor="recipient">Wallet address</label>
            <input
              id="recipient"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="Paste your Thruput wallet address"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={!!saved || busy}
            />
            <p className="hint">
              One starter pack per address every {config.cooldownSeconds / 3600}{" "}
              hours. Network and daily limits also apply.
            </p>
            <button
              disabled={
                busy ||
                !storageReady ||
                !recipient ||
                (!saved && !config.available) ||
                !!terminal
              }
              type="submit"
            >
              {busy
                ? "Checking claim…"
                : terminal
                  ? "Claim complete"
                  : saved
                    ? "Check or recover claim"
                    : config.available
                      ? "Get starter pack"
                      : "Faucet temporarily unavailable"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {saved && (
            <div className="result" role="status">
              <h3>
                {result?.status === "confirmed"
                  ? "Your tokens are ready"
                  : result?.status === "failed"
                    ? "Claim did not complete"
                    : "Claim saved"}
              </h3>
              <p>
                {result?.status === "confirmed"
                  ? "All six tokens were transferred to your wallet."
                  : result?.status === "failed"
                    ? "No starter pack was paid. The cooldown still applies."
                    : "We will check the original claim. Keep this page or return later; no replacement payout will be sent."}
              </p>
              <p className="hash">Claim: {saved.id}</p>
              {result?.hash && (
                <p className="hash">Transaction: {result.hash}</p>
              )}
              {status.error && <p className="error">{status.error.message}</p>}
              {terminal && (
                <>
                  <p className="hint">
                    Next claim: {new Date(result.retryAt).toLocaleString()}
                  </p>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      try {
                        localStorage.removeItem(key);
                        setSaved(null);
                        setError("");
                      } catch {
                        setError("Could not update browser storage.");
                      }
                    }}
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          )}
        </section>
        <section className="pack">
          <h2>Inside your starter pack</h2>
          <ul role="list">
            {config.tokens.map((token) => (
              <li key={token.address}>
                <div className="token-mark" aria-hidden="true">
                  {token.symbol.slice(1, 2)}
                </div>
                <div className="token-name">
                  <h3>{token.symbol}</h3>
                  <p>{token.name}</p>
                </div>
                <p className="amount">
                  {formatUnits(BigInt(token.claimAmount), token.decimals)}
                </p>
              </li>
            ))}
          </ul>
          <a className="swap-link" href={config.swapUrl}>
            Open Swap <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </div>
    </main>
  );
}
export function App() {
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => request<Config>("config"),
    refetchInterval: 30_000,
  });
  return (
    <div className="app">
      <header>
        <a className="brand" href="/">
          thruput<span className="divider">/</span>
          <span>Token Faucet</span>
        </a>
        <a
          className="source"
          href="https://github.com/thruputchain/thruput-examples/tree/main/apps/token-faucet"
        >
          View source <ExternalLink size={14} aria-hidden="true" />
        </a>
      </header>
      {config.data ? (
        <Faucet
          key={`${config.data.networkId}:${config.data.anchorHash}`}
          config={config.data}
        />
      ) : (
        <main>
          <h1>Token Faucet</h1>
          <p role="status">
            {config.error ? config.error.message : "Loading starter pack…"}
          </p>
        </main>
      )}
      <footer>
        Test tokens. Real transactions.{" "}
        <a href="https://docs.thruput.network/">Read the docs ↗</a>
      </footer>
    </div>
  );
}
