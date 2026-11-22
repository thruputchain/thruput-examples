import { Link, NavLink, Route, Routes } from "react-router-dom";
import type { AppConfig } from "./config";
import { TransactionStatus } from "./components/transaction-status";
import { WalletControls } from "./components/wallet-controls";
import { DropList } from "./pages/drop-list";
import { DropPage } from "./pages/drop-page";
import { NewDrop } from "./pages/new-drop";
import { useTransaction } from "./transactions/use-transaction";

export function App({ config }: { config: AppConfig }) {
  const transaction = useTransaction(config);
  return (
    <>
      <header>
        <div className="header-inner">
          <Link to="/" aria-label="Thruput NFT Drop homepage" className="brand">
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
            <span>Thruput NFT Drop</span>
          </Link>
          <nav className="desktop-nav" aria-label="Main">
            <NavLink to="/" end>
              Drops
            </NavLink>
            <NavLink to="/new">New drop</NavLink>
          </nav>
          <div className="actions ml-auto">
            <WalletControls />
          </div>
        </div>
      </header>
      <main>
        <TransactionStatus transaction={transaction} />
        <Routes>
          <Route path="/" element={<DropList config={config} />} />
          <Route
            path="/new"
            element={<NewDrop config={config} transaction={transaction} />}
          />
          <Route
            path="/drops/:address"
            element={<DropPage config={config} transaction={transaction} />}
          />
          <Route
            path="*"
            element={
              <p>
                Page not found. <Link to="/">See all drops</Link>
              </p>
            }
          />
        </Routes>
      </main>
    </>
  );
}
