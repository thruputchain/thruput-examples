import { useEffect } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useWallet } from "@thruputchain/react";
import type { AppConfig } from "./config";
import {
  useTransaction,
  type Transaction,
} from "./transactions/use-transaction";
import { TransactionStatus } from "./components/transaction-status";
import { WalletControls } from "./components/wallet-controls";
import { PollEditor } from "./components/poll-editor";
import { PollList } from "./pages/poll-list";
import { PollDetail } from "./pages/poll-detail";
import { GAS, methods } from "./contracts/polls";

function Navigation() {
  return (
    <>
      <NavLink to="/" end>
        Explore
      </NavLink>
      <NavLink to="/admin">My polls</NavLink>
    </>
  );
}

export function App({ config }: { config: AppConfig }) {
  const transaction = useTransaction(config);
  return (
    <>
      <header>
        <div className="header-inner">
          <Link to="/" aria-label="Thruput Voting homepage" className="brand">
            <picture>
              <source
                srcSet={`${import.meta.env.BASE_URL}brand/stellar-dark.svg`}
                media="(prefers-color-scheme: dark)"
              />
              <img
                src={`${import.meta.env.BASE_URL}brand/stellar.svg`}
                width="100"
                height="25"
                alt="Stellar"
              />
            </picture>
            <span>Thruput Voting</span>
          </Link>
          <nav className="desktop-nav" aria-label="Main">
            <Navigation />
          </nav>
          <div className="actions ml-auto">
            <Link className="button primary" to="/new">
              Create poll
            </Link>
            <WalletControls />
          </div>
          <details className="mobile-nav">
            <summary>Menu</summary>
            <nav aria-label="Mobile">
              <Navigation />
            </nav>
          </details>
        </div>
      </header>
      <main>
        <TransactionStatus transaction={transaction} />
        <Routes>
          <Route path="/" element={<PollList config={config} />} />
          <Route
            path="/admin"
            element={<PollList key="admin" config={config} admin />}
          />
          <Route
            path="/new"
            element={<CreatePoll config={config} transaction={transaction} />}
          />
          <Route
            path="/polls/:id"
            element={<PollDetail config={config} transaction={transaction} />}
          />
          <Route
            path="*"
            element={
              <p>
                Page not found. <Link to="/">Explore polls</Link>
              </p>
            }
          />
        </Routes>
      </main>
    </>
  );
}

function CreatePoll({
  config,
  transaction: tx,
}: {
  config: AppConfig;
  transaction: Transaction;
}) {
  const wallet = useWallet();
  const navigate = useNavigate();
  useEffect(() => {
    if (tx.completed !== "Create poll") return;
    tx.dismissConfirmation();
    navigate("/admin");
  }, [tx.completed, navigate]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">New poll</p>
          <h1>Start with a question</h1>
          <p className="muted">
            Save a draft, review it, then open voting for everyone.
          </p>
        </div>
      </div>
      {wallet.status !== "connected" ? (
        <p className="notice">
          Connect your wallet to create a poll. Your wallet will be its admin.
        </p>
      ) : null}
      <PollEditor
        initial={{
          title: "",
          description: "",
          questions: [{ title: "", options: ["", ""] }],
        }}
        disabled={wallet.status !== "connected" || tx.blocked}
        onSave={(definition) =>
          tx.send(
            "Create poll",
            methods.createPoll.invocation(config.address, GAS, { definition }),
          )
        }
      />
    </>
  );
}
