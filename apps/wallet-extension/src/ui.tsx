import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type { WalletAccount } from "@groundhogchain/client/provider";
import type { TransactionReview } from "./transactions";
import type { Network, Token } from "./network";
import {
  unresolved,
  PENDING_TRANSFER_ADVISORY,
  type OutgoingTransfer,
} from "./lifecycle";
import "./ui.css";

// Chrome sizes toolbar popups from their content, so their layout must not
// depend on that same viewport width. Tabs and approval windows stay responsive.
document.documentElement.classList.toggle(
  "wallet-popup",
  chrome.extension.getViews({ type: "popup" }).includes(window),
);

interface State {
  exists: boolean;
  unlocked: boolean;
  network: Network;
  networkHash: string;
  expires: number;
  accounts: (WalletAccount & { name: string; index?: number })[];
  sites: string[];
  outgoing: OutgoingTransfer[];
  recoveryBlocked: boolean;
}
interface Approval {
  id: string;
  origin: string;
  method: string;
  networkHash: string;
  account?: string;
  review?: TransactionReview;
  accounts: State["accounts"];
}
interface Prepared {
  transaction: string;
  networkHash: string;
  review: TransactionReview;
}
function useRequestScope(scope: string | undefined) {
  const current = useRef({ scope, generation: 0 });
  if (current.current.scope !== scope) {
    current.current = { scope, generation: current.current.generation + 1 };
  }
  const invalidate = useCallback(() => {
    current.current.generation++;
  }, []);
  const begin = useCallback(() => {
    const { scope } = current.current;
    const generation = ++current.current.generation;
    return {
      generation,
      isCurrent: () =>
        scope !== undefined &&
        current.current.scope === scope &&
        current.current.generation === generation,
    };
  }, []);
  return { begin, invalidate, generation: current.current.generation };
}
async function rpc<T>(op: string, data: object = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ kind: "ui", op, ...data });
  if (reply.error) throw new Error(reply.error.message);
  return reply.result as T;
}
function Field({
  label,
  name,
  type = "text",
  required = true,
  placeholder,
  autoComplete = type === "password" ? "current-password" : "off",
  minLength,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        spellCheck={false}
      />
    </label>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={primary ? "primary" : ""}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
function Review({ review }: { review: TransactionReview }) {
  return (
    <section className="review">
      <div className="warning">
        <strong>Not simulated</strong>
        <p>
          This is a decoded request, not a prediction. Contracts can move assets
          or change permissions. Only approve calls you understand.
        </p>
      </div>
      <dl>
        <dt>Root method</dt>
        <dd>DefaultWallet.{review.method}</dd>
        <dt>Root entrypoint</dt>
        <dd className="mono">{review.entrypoint}</dd>
        {review.deployment ? (
          <>
            <dt>Deployment nonce</dt>
            <dd className="mono">{review.deployment.nonce}</dd>
            <dt>Contract hash</dt>
            <dd className="mono">{review.deployment.contractHash}</dd>
          </>
        ) : null}
        <dt>Account</dt>
        <dd className="mono">{review.root}</dd>
        <dt>Root gas limit</dt>
        <dd>{review.gas}</dd>
        <dt>Expires at block</dt>
        <dd>{review.expiry}</dd>
        <dt>Transaction nonce</dt>
        <dd>{review.nonce}</dd>
      </dl>
      {review.calls.map((call, i) => (
        <article className="call" key={i}>
          <h3>
            Call {i + 1}
            {call.decodedTransfer
              ? " / ERC20 transfer ABI (unverified)"
              : " / Contract call"}
          </h3>
          {call.decodedTransfer ? (
            <p>Decoded fields do not verify target contract or effects.</p>
          ) : null}
          <dl>
            <dt>Target</dt>
            <dd className="mono">{call.target}</dd>
            <dt>Entrypoint</dt>
            <dd className="mono">{call.entrypoint}</dd>
            <dt>Gas limit</dt>
            <dd>{call.gas}</dd>
            {call.decodedTransfer ? (
              <>
                <dt>Decoded receiver</dt>
                <dd className="mono">{call.decodedTransfer.receiver}</dd>
                <dt>Decoded amount (raw integer)</dt>
                <dd>{call.decodedTransfer.amount}</dd>
              </>
            ) : null}
          </dl>
          <details>
            <summary>Calldata</summary>
            <pre>{call.calldata}</pre>
          </details>
        </article>
      ))}
      <details>
        <summary>
          Root calldata and deployments ({review.deployments.length})
        </summary>
        <pre>{review.calldata}</pre>
        {review.deployments.map((code, i) => (
          <pre key={i}>{code}</pre>
        ))}
      </details>
    </section>
  );
}
function App() {
  const approvalId = new URLSearchParams(location.search).get("approval");
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [page, setPage] = useState<"assets" | "send" | "settings">("assets");
  const [selected, setSelected] = useState("");
  const [portfolio, setPortfolio] = useState<{
    scope: string;
    tokens: Token[];
    loading: boolean;
  }>();
  const [portfolioRefresh, setPortfolioRefresh] = useState(0);
  const [approval, setApproval] = useState<Approval>();
  const [allowed, setAllowed] = useState<string[]>([]);
  const [preparation, setPreparation] = useState<{
    generation: number;
    value: Prepared;
  }>();
  const [backup, setBackup] = useState<{
    mnemonic: string;
    derivation: string;
    importedKeys: { name: string; key: string }[];
  }>();
  const account =
    state?.accounts.find((a) => a.address === selected) || state?.accounts[0];
  const scope =
    state?.unlocked && account
      ? JSON.stringify([
          account.address,
          state.network,
          state.networkHash,
          state.expires,
        ])
      : undefined;
  const portfolioRequests = useRequestScope(scope);
  const preparationRequests = useRequestScope(scope);
  const tokens = portfolio?.scope === scope ? portfolio?.tokens || [] : [];
  const loadingTokens = Boolean(
    scope && (!portfolio || portfolio.scope !== scope || portfolio.loading),
  );
  const prepared =
    preparation?.generation === preparationRequests.generation
      ? preparation.value
      : undefined;
  function clearPrepared() {
    preparationRequests.invalidate();
    setPreparation(undefined);
  }
  async function refresh() {
    const next = await rpc<State>("state");
    setState(next);
    if (!next.unlocked) {
      setBackup(undefined);
      clearPrepared();
      portfolioRequests.invalidate();
      setPortfolio(undefined);
    }
    return next;
  }
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet operation failed");
    } finally {
      setBusy(false);
    }
  }
  function form(
    event: FormEvent<HTMLFormElement>,
    task: (values: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    const target = event.currentTarget;
    const values = new FormData(target);
    void run(async () => {
      try {
        await task(values);
      } finally {
        target
          .querySelectorAll<HTMLInputElement>('input[type="password"]')
          .forEach((input) => {
            input.value = "";
          });
      }
    });
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const listener = (message: { kind?: string }) => {
      if (message.kind === "stateChanged") void refresh().catch(() => {});
    };
    chrome.runtime.onMessage.addListener(listener);
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 10000);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!approvalId) return;
    let active = true;
    void rpc<Approval>("approval", { id: approvalId }).then(
      (a) => {
        if (!active) return;
        setApproval(a);
        setAllowed(a.accounts.map((account) => account.address));
      },
      (e) => {
        if (!active) return;
        setApproval(undefined);
        setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [approvalId, state?.unlocked]);
  useEffect(() => {
    if (!backup) return;
    const timer = setTimeout(() => setBackup(undefined), 60000);
    return () => clearTimeout(timer);
  }, [backup]);
  useEffect(() => {
    if (!scope || approvalId) return;
    const { isCurrent } = portfolioRequests.begin();
    setPortfolio({ scope, tokens: [], loading: true });
    rpc<Token[]>("portfolio", { account: account!.address }).then(
      (result) => {
        if (isCurrent())
          setPortfolio({ scope, tokens: result, loading: false });
      },
      (e) => {
        if (isCurrent()) {
          setPortfolio({ scope, tokens: [], loading: false });
          setError(e.message);
        }
      },
    );
    return portfolioRequests.invalidate;
  }, [
    scope,
    approvalId,
    portfolioRefresh,
    portfolioRequests.begin,
    portfolioRequests.invalidate,
  ]);
  const refreshTokens = () => setPortfolioRefresh((version) => version + 1);
  const lock = () => {
    setBackup(undefined);
    clearPrepared();
    portfolioRequests.invalidate();
    void run(async () => {
      await rpc("lock");
      await refresh();
    });
  };
  return (
    <main>
      <header>
        <a className="brand" href="index.html" aria-label="Thruput Wallet home">
          <img
            className="mark"
            src="favicon.svg"
            width="24"
            height="24"
            alt=""
          />
          <span>THRUPUT</span>
          <span className="subbrand">Wallet</span>
        </a>
      </header>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}
      {!state ? (
        <p role="status">Opening your wallet...</p>
      ) : !state.exists ? (
        <section className="welcome">
          <h1>Set up your wallet</h1>
          <div className="setup-tabs" role="tablist" aria-label="Wallet setup">
            {(
              [
                ["create", "New wallet"],
                ["restore", "Restore wallet"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`setup-${value}`}
                aria-selected={mode === value}
                aria-controls="wallet-setup-panel"
                tabIndex={mode === value ? 0 : -1}
                disabled={busy}
                onClick={() => {
                  setMode(value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "create"
                      : event.key === "End"
                        ? "restore"
                        : mode === "create"
                          ? "restore"
                          : "create";
                  setMode(next);
                  setError("");
                  document.getElementById(`setup-${next}`)?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            id="wallet-setup-panel"
            role="tabpanel"
            aria-labelledby={`setup-${mode}`}
          >
            <h2>
              {mode === "create" ? "Create a wallet" : "Restore a wallet"}
            </h2>
            <p>
              {mode === "create"
                ? "Choose a password with at least 12 characters and enter it twice. This password encrypts your wallet on this device. Use it to unlock your wallet later."
                : "Enter your recovery phrase, then choose a password for this device. You do not need the password from your previous device."}
            </p>
            <form
              key={mode}
              onSubmit={(e) =>
                form(e, async (values) => {
                  if (values.get("password") !== values.get("confirm"))
                    throw new Error("Passwords do not match");
                  await rpc("create", {
                    password: values.get("password"),
                    ...(mode === "restore"
                      ? { mnemonic: values.get("mnemonic") }
                      : {}),
                  });
                  await refresh();
                  setPage("settings");
                  setNotice(
                    "Wallet ready. Back up your recovery phrase below before adding funds.",
                  );
                })
              }
            >
              {mode === "restore" ? (
                <label>
                  Recovery phrase
                  <textarea
                    name="mnemonic"
                    required
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ) : null}
              <Field
                label="Password (at least 12 characters)"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
              />
              <Field
                label="Confirm password"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
              />
              <button type="submit" className="primary" disabled={busy}>
                {busy
                  ? "Encrypting..."
                  : mode === "create"
                    ? "Create wallet"
                    : "Restore wallet"}
              </button>
              <details>
                <summary>Technical details</summary>
                <p className="hint">
                  For Groundhog localnet and devnet. Testnet derivation:
                  m/44'/1'/index', Ed25519 SLIP-0010, address nonce 0.
                  No BIP39 passphrase.
                </p>
              </details>
            </form>
          </div>
        </section>
      ) : !state.unlocked ? (
        <section className="welcome">
          <h1>Welcome back.</h1>
          {approvalId ? (
            <>
              {approval ? <p className="origin">{approval.origin}</p> : null}
              <p>
                Unlock to review this connection request. Unlocking does not
                approve it.
              </p>
            </>
          ) : (
            <p>Unlock your wallet to connect, sign, and explore.</p>
          )}
          <form
            onSubmit={(e) =>
              form(e, async (values) => {
                await rpc("unlock", { password: values.get("password") });
                await refresh();
              })
            }
          >
            <Field label="Password" name="password" type="password" />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Unlocking..." : "Unlock wallet"}
            </button>
          </form>
          <p className="hint">
            Locks after 10 minutes or when the background worker restarts. Your
            password never leaves this extension.
          </p>
        </section>
      ) : approvalId ? (
        <section>
          <span className="eyebrow">Wallet request</span>
          <h1>
            {approval?.method === "connect"
              ? "Connect to this site?"
              : "Approve a signature?"}
          </h1>
          {approval ? (
            <>
              <p className="origin">
                <span>Requesting site</span>
                {approval.origin}
              </p>
              <p>
                {approval.method === "connect"
                  ? "This site can see the selected account addresses. Every signature still needs your approval."
                  : "Signing does not broadcast. This site may later submit these exact signed bytes while connected and unlocked."}
              </p>
              <dl className="request-network">
                <dt>Network</dt>
                <dd>
                  {state.network === "localnet" ? "Localnet" : "Devnet"} /
                  Testnet only
                </dd>
              </dl>
              <details>
                <summary>Network identity</summary>
                <pre>{approval.networkHash}</pre>
              </details>
              {approval.method === "connect" ? (
                <fieldset>
                  <legend>Share accounts</legend>
                  {approval.accounts.map((a) => (
                    <label className="check" key={a.address}>
                      <input
                        name="accounts"
                        type="checkbox"
                        checked={allowed.includes(a.address)}
                        onChange={(e) =>
                          setAllowed(
                            e.target.checked
                              ? [...allowed, a.address]
                              : allowed.filter((value) => value !== a.address),
                          )
                        }
                      />
                      <span>
                        {a.name}
                        <code>{a.address}</code>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : approval.review ? (
                <Review review={approval.review} />
              ) : null}
              <div className="actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await rpc("decide", { id: approvalId, approve: false });
                      window.close();
                    })
                  }
                >
                  Reject
                </Button>
                <Button
                  primary
                  disabled={
                    busy || (approval.method === "connect" && !allowed.length)
                  }
                  onClick={() =>
                    void run(async () => {
                      await rpc("decide", {
                        id: approvalId,
                        approve: true,
                        accounts: allowed,
                      });
                      window.close();
                    })
                  }
                >
                  {busy
                    ? "Approving..."
                    : approval.method === "connect"
                      ? "Connect"
                      : "Sign only"}
                </Button>
              </div>
            </>
          ) : (
            <p>
              This request is no longer available. Return to the site and
              request again.
            </p>
          )}
        </section>
      ) : (
        <>
          <div className="toolbar">
            <label className="sr-only" htmlFor="network">
              Network
            </label>
            <select
              id="network"
              name="network"
              value={
                /^[0-9a-f]{64}$/.test(state.networkHash) ? state.network : ""
              }
              disabled={busy}
              onChange={(e) => {
                clearPrepared();
                void run(async () => {
                  await rpc("network", { network: e.target.value });
                  await refresh();
                });
              }}
            >
              <option value="" disabled>
                Select network
              </option>
              <option value="localnet">Localnet</option>
              <option value="devnet">Devnet</option>
            </select>
            <div className="toolbar-actions">
              <Button
                disabled={busy}
                title="Reconnect the network. You will need to reconnect your apps afterward."
                onClick={() => {
                  clearPrepared();
                  void run(async () => {
                    await rpc("network", { network: state.network });
                    await refresh();
                    setNotice("Network reconnected. Reconnect your apps.");
                  });
                }}
              >
                Reconnect
              </Button>
              <Button onClick={lock}>Lock</Button>
            </div>
          </div>
          <label className="sr-only" htmlFor="account">
            Account
          </label>
          <select
            id="account"
            name="account"
            value={account?.address || ""}
            onChange={(e) => {
              setSelected(e.target.value);
              clearPrepared();
            }}
          >
            {state.accounts.map((a) => (
              <option key={a.address} value={a.address}>
                {a.name}
                {a.index === undefined ? " (imported)" : ` / ${a.index}`}
              </option>
            ))}
          </select>
          {account ? (
            <div>
              <p className="address">{account.address}</p>
              <button
                type="button"
                className="copy-address"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(account.address);
                    setNotice("Address copied.");
                  })
                }
              >
                Copy address
              </button>
            </div>
          ) : (
            <p>No accounts. Add an account in settings.</p>
          )}
          <nav aria-label="Wallet sections">
            {(["assets", "send", "settings"] as const).map((tab) => (
              <button
                type="button"
                key={tab}
                aria-current={page === tab ? "page" : undefined}
                onClick={() => {
                  setPage(tab);
                  setBackup(undefined);
                }}
              >
                {tab === "assets"
                  ? "Assets"
                  : tab === "send"
                    ? "Send"
                    : "Settings"}
              </button>
            ))}
          </nav>
          {state.recoveryBlocked && (
            <p className="warning" role="status">
              Transfer recovery data is damaged. Wallet sends are blocked.
              Keep all known hashes and check their outcomes. Follow Manual
              storage recovery in the wallet README before sending again.
              A recovery phrase does not restore transfer history.
            </p>
          )}
          {state.outgoing.length ? (
            <section aria-label="Outgoing transfers">
              <h2>Outgoing transfers</h2>
              <p>
                These hashes survive popup closure and wallet lock. Checking
                status never signs or broadcasts.
              </p>
              {state.outgoing.map((transfer) => (
                <article
                  className="call"
                  key={`${transfer.networkHash}:${transfer.hash}`}
                >
                  <strong>
                    {transfer.network} /{" "}
                    {transfer.outcome === "unknown"
                      ? "Broadcast outcome unknown"
                      : transfer.outcome === "submitted"
                        ? "Execution not yet confirmed"
                        : transfer.outcome}
                  </strong>
                  <p className="mono">{transfer.hash}</p>
                  <details>
                    <summary>Account and network identity</summary>
                    <pre>
                      {transfer.account}
                      {"\n"}
                      {transfer.networkHash}
                    </pre>
                  </details>
                  {unresolved(transfer) ? (
                    <div className="warning" role="status">
                      <p>{PENDING_TRANSFER_ADVISORY}</p>
                      {transfer.advisory ? <p>{transfer.advisory}</p> : null}
                    </div>
                  ) : null}
                  <div className="actions">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await rpc("observeTransfer", {
                            hash: transfer.hash,
                            networkHash: transfer.networkHash,
                          });
                          await refresh();
                        })
                      }
                    >
                      Check status
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            unresolved(transfer)
                              ? "This transaction may still execute. Acknowledging removes the duplicate-transfer guard. Have you recorded the hash and understood the risk of sending twice?"
                              : "Dismiss this completed transfer record?",
                          )
                        )
                          void run(async () => {
                            await rpc("ackTransfer", {
                              hash: transfer.hash,
                              networkHash: transfer.networkHash,
                              confirmRisk: true,
                            });
                            await refresh();
                          });
                      }}
                    >
                      Acknowledge
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          {page === "assets" ? (
            <section>
              <div className="section-heading">
                <h1>Your assets</h1>
                <Button
                  disabled={busy || !account || loadingTokens}
                  onClick={() => {
                    setError("");
                    setNotice("");
                    refreshTokens();
                  }}
                >
                  Refresh
                </Button>
              </div>
              {loadingTokens ? (
                <p role="status">Reading balances...</p>
              ) : (
                <ul className="tokens">
                  {tokens.map((token) => (
                    <li key={token.address}>
                      <div className="token-symbol">
                        {token.symbol.slice(0, 1)}
                      </div>
                      <div>
                        <strong>{token.symbol}</strong>
                        <span>
                          {token.address === `0x${"0".repeat(63)}1`
                            ? "Native token"
                            : "Manually added"}
                        </span>
                      </div>
                      <div className="balance">
                        {token.error ? (
                          <span title={token.error}>Unavailable</span>
                        ) : (
                          formatBalance(token.balance || "0", token.decimals)
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="actions">
                <Button
                  primary
                  disabled={busy || !account}
                  onClick={() =>
                    void run(async () => {
                      const result = await rpc<{ hash: string }>("airdrop", {
                        account: account!.address,
                      });
                      setNotice(`Airdrop confirmed: ${result.hash}`);
                      refreshTokens();
                    })
                  }
                >
                  {busy ? "Working..." : "Request test HOG"}
                </Button>
                <Button disabled={!account} onClick={() => setPage("send")}>
                  Send tokens
                </Button>
              </div>
              <details>
                <summary>Add a token</summary>
                <form
                  onSubmit={(e) =>
                    form(e, async (values) => {
                      await rpc("addToken", { address: values.get("address") });
                      refreshTokens();
                      setNotice(
                        "Token added. Metadata is provided by the token contract.",
                      );
                    })
                  }
                >
                  <Field
                    label="Token contract address"
                    name="address"
                    placeholder="0x... (32 bytes)"
                  />
                  <button type="submit" disabled={busy}>
                    Add token
                  </button>
                </form>
              </details>
            </section>
          ) : page === "send" ? (
            <section>
              <h1>Send tokens</h1>
              <p>Review the exact transaction before signing and sending.</p>
              {prepared ? (
                <>
                  <Review review={prepared.review} />
                  <div className="actions">
                    <Button disabled={busy} onClick={clearPrepared}>
                      Back
                    </Button>
                    <Button
                      primary
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const tx = prepared;
                          clearPrepared();
                          const result = await rpc<{
                            hash: string;
                            status: string;
                          }>("sendTransfer", {
                            account: account!.address,
                            transaction: tx.transaction,
                            networkHash: tx.networkHash,
                          });
                          if (result.status === "Confirmed")
                            setNotice(`Confirmed: ${result.hash}`);
                          else if (result.status === "Execution failed")
                            setError(`Execution failed: ${result.hash}`);
                          await refresh();
                          refreshTokens();
                        })
                      }
                    >
                      Sign and send
                    </Button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={(e) =>
                    form(e, async (values) => {
                      const { generation, isCurrent } =
                        preparationRequests.begin();
                      try {
                        const value = await rpc<Prepared>("prepareTransfer", {
                          account: account!.address,
                          token: values.get("token"),
                          receiver: values.get("receiver"),
                          amount: values.get("amount"),
                        });
                        if (isCurrent()) setPreparation({ generation, value });
                      } catch (error) {
                        if (isCurrent()) throw error;
                      }
                    })
                  }
                >
                  <label>
                    Token
                    <select name="token" required>
                      {tokens.map((t) => (
                        <option key={t.address} value={t.address}>
                          {t.symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    label="Recipient address"
                    name="receiver"
                    placeholder="0x... (32 bytes)"
                  />
                  <Field label="Amount" name="amount" placeholder="0.00" />
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !account || !tokens.length}
                  >
                    {busy ? "Preparing..." : "Review transfer"}
                  </button>
                </form>
              )}
            </section>
          ) : (
            <section>
              <h1>Wallet settings</h1>
              <p>Local keys. Explicit permissions.</p>
              <details open>
                <summary>Accounts</summary>
                <p className="hint">
                  Derived accounts use the next unused index. Removing an
                  imported key requires its separate backup to recover it.
                </p>
                <div className="actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await rpc("addAccount");
                        await refresh();
                        setNotice("Account added.");
                      })
                    }
                  >
                    Add derived account
                  </Button>
                  <Button
                    disabled={busy || !account}
                    onClick={() => {
                      if (
                        confirm(
                          "Remove this account from the wallet? Make sure you have backed up its recovery phrase or imported private key.",
                        )
                      )
                        void run(async () => {
                          await rpc("removeAccount", {
                            account: account!.address,
                          });
                          await refresh();
                        });
                    }}
                  >
                    Remove selected
                  </Button>
                </div>
                <form
                  onSubmit={(e) =>
                    form(e, async (values) => {
                      await rpc("addAccount", { key: values.get("key") });
                      await refresh();
                      setNotice(
                        "Private key imported. This account is not recoverable from the wallet phrase.",
                      );
                    })
                  }
                >
                  <Field
                    label="Import private key (32-byte Ed25519 seed)"
                    name="key"
                    type="password"
                  />
                  <button type="submit" disabled={busy}>
                    Import key
                  </button>
                </form>
              </details>
              <details>
                <summary>Recovery backup</summary>
                <p>
                  Never share this phrase or imported keys. Anyone with them can
                  control your accounts. Hidden again after one minute.
                </p>
                {backup ? (
                  <>
                    <ol className="seed">
                      {backup.mnemonic.split(" ").map((word, i) => (
                        <li key={i}>
                          <span>{i + 1}</span>
                          {word}
                        </li>
                      ))}
                    </ol>
                    <p className="mono">{backup.derivation}</p>
                    {backup.importedKeys.map((key, i) => (
                      <div key={i}>
                        <strong>{key.name} / imported private key</strong>
                        <pre>{key.key}</pre>
                      </div>
                    ))}
                    <Button onClick={() => setBackup(undefined)}>
                      Hide backup
                    </Button>
                  </>
                ) : (
                  <form
                    onSubmit={(e) =>
                      form(e, async (values) => {
                        setBackup(
                          await rpc("export", {
                            password: values.get("password"),
                          }),
                        );
                      })
                    }
                  >
                    <Field
                      label="Re-enter password"
                      name="password"
                      type="password"
                    />
                    <button type="submit" disabled={busy}>
                      Reveal recovery backup
                    </button>
                  </form>
                )}
              </details>
              <details>
                <summary>Connected sites ({state.sites.length})</summary>
                <p className="hint">
                  Connections survive lock/unlock. A background worker restart
                  requires fresh site approval.
                </p>
                {state.sites.length ? (
                  state.sites.map((origin) => (
                    <div className="site" key={origin}>
                      <span>{origin}</span>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await rpc("revoke", { origin });
                            await refresh();
                          })
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  ))
                ) : (
                  <p>No sites connected.</p>
                )}
              </details>
              <details>
                <summary>Network and security</summary>
                <p className="mono">{state.networkHash}</p>
                <p>
                  Automatic lock: 10 minutes after unlock. A background worker
                  restart also locks the wallet. Devnet uses HTTPS and a pinned
                  network identity.
                </p>
                <p className="hint">
                  Thruput Wallet 0.1.0 / Experimental software. Use test funds
                  only.
                </p>
              </details>
            </section>
          )}
        </>
      )}
    </main>
  );
}
function formatBalance(value: string, decimals: number) {
  const raw = BigInt(value),
    scale = 10n ** BigInt(decimals);
  const fraction = (raw % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${raw / scale}${fraction ? `.${fraction}` : ""}`;
}
createRoot(document.getElementById("root")!).render(<App />);
