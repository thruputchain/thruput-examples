import { useQuery } from "@tanstack/react-query";
import { useClient, useWallet } from "@thruputchain/react";
import { addressFromBase58, formatUnits, toBase58 } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { ArrowRight, Droplets, ExternalLink } from "lucide-react";
import { Airdrop } from "./contracts/generated/airdrop";
import { useClaim } from "./claim";
import type { PublicConfig } from "../shared/config";

export function App({ config }: { config: PublicConfig }) {
  const client = useClient();
  const wallet = useWallet();
  const claim = useClaim(config);
  const contract = addressFromBase58(config.address);
  const state = useQuery({
    queryKey: ["airdrop", config.address, wallet.address],
    refetchInterval: 10_000,
    queryFn: async () => {
      const anchor = await client.getBlockByHeight({
        blockHeight: BigInt(config.anchorHeight),
      });
      if (!anchor || toBase58(anchor.blockHash) !== config.anchorHash)
        throw new Error("Chain checkpoint changed. Update the deployment.");
      const options = { client, address: contract };
      const definition = (await Airdrop.v0_1.config.view(options)).value;
      if (
        definition.rewards.length !== config.tokens.length ||
        definition.rewards.some(
          (r, i) =>
            toBase58(r.token) !== config.tokens[i]!.address ||
            String(r.amount) !== config.tokens[i]!.claimAmount,
        )
      )
        throw new Error(
          "Token configuration does not match the deployed airdrop.",
        );
      const balances = await Promise.all(
        config.tokens.map((t) =>
          ERC20.v0_1.getBalanceOf.view({
            client,
            address: addressFromBase58(t.address),
            args: { addr: contract },
          }),
        ),
      );
      const funded = balances.every(
        (b, i) => b.value >= BigInt(config.tokens[i]!.claimAmount),
      );
      if (!wallet.address)
        return {
          restricted: definition.restricted,
          eligible: false,
          claimed: false,
          funded,
        };
      const args = { address: addressFromBase58(wallet.address) };
      const [eligible, claimed] = await Promise.all([
        Airdrop.v0_1.eligible.view({ ...options, args }),
        Airdrop.v0_1.hasClaimed.view({ ...options, args }),
      ]);
      return {
        restricted: definition.restricted,
        eligible: eligible.value,
        claimed: claimed.value,
        funded,
      };
    },
  });
  const connected = wallet.status === "connected";
  return (
    <div className="app">
      <header>
        <a className="brand" href="/">
          thruput<span className="divider">/</span>
          <span>Airdrop</span>
        </a>
        <a
          className="source"
          href="https://github.com/thruputchain/thruput-examples/tree/main/apps/airdrop"
        >
          View source <ExternalLink size={14} aria-hidden="true" />
        </a>
      </header>
      <main>
        <div className="layout">
          <section className="panel">
            <div className="section-title">
              <Droplets size={22} aria-hidden="true" />
              <h1>Claim your airdrop</h1>
            </div>
            <p className="muted">
              One claim per wallet. All tokens are transferred together by the
              airdrop contract.
            </p>
            <p className="hint">
              These test tokens have no monetary value. Your wallet needs native
              tokens to submit the claim.
            </p>
            {wallet.providers.length > 1 && !connected && (
              <select
                aria-label="Wallet provider"
                value={wallet.provider?.info.id || ""}
                onChange={(e) => wallet.selectProvider(e.target.value)}
              >
                {wallet.providers.map((p) => (
                  <option key={p.info.id} value={p.info.id}>
                    {p.info.name}
                  </option>
                ))}
              </select>
            )}
            {connected || wallet.status === "wrongNetwork" ? (
              <>
                <p className="hash">{wallet.address}</p>
                <button
                  className="secondary"
                  onClick={() => void wallet.disconnect()}
                >
                  Disconnect wallet
                </button>
              </>
            ) : (
              <button
                disabled={!wallet.provider || wallet.status === "connecting"}
                onClick={() => void wallet.connect()}
              >
                {wallet.status === "connecting"
                  ? "Connecting…"
                  : "Connect wallet"}
              </button>
            )}
            {wallet.session && wallet.session.accounts.length > 1 && (
              <select
                aria-label="Wallet account"
                value={wallet.address || ""}
                onChange={(e) => wallet.selectAccount(e.target.value)}
              >
                {wallet.session.accounts.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.address}
                  </option>
                ))}
              </select>
            )}
            {!wallet.provider && (
              <p className="hint">
                Install Thruput Freighter to connect your wallet.
              </p>
            )}
            {wallet.status === "wrongNetwork" && (
              <p role="alert" className="error">
                Select this app's network in your wallet.
              </p>
            )}
            {wallet.error && (
              <p role="alert" className="error">
                {wallet.error.message}
              </p>
            )}
            {state.data && (
              <p className="hint">
                {state.data.restricted
                  ? "Only addresses on this airdrop's allowlist can claim."
                  : "Open to any wallet address."}
              </p>
            )}
            {state.error && (
              <p role="alert" className="error">
                {state.error.message}
              </p>
            )}
            <button
              disabled={
                !connected ||
                claim.blocked ||
                !state.data?.eligible ||
                state.data.claimed ||
                !state.data.funded ||
                state.isError
              }
              onClick={() => void claim.send()}
            >
              {claim.busy
                ? "Confirm in your wallet…"
                : state.data?.claimed
                  ? "Already claimed"
                  : connected && state.data && !state.data.eligible
                    ? "Address is not eligible"
                    : state.data && !state.data.funded
                      ? "Airdrop is out of tokens"
                      : "Claim airdrop"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            {claim.error && (
              <p role="alert" className="error">
                {claim.error}
              </p>
            )}
            {claim.pending && (
              <div className="result">
                <h2>
                  {claim.settled
                    ? claim.receipt.data &&
                      "result" in claim.receipt.data.execution &&
                      claim.receipt.data.execution.result === "return"
                      ? "Airdrop claimed"
                      : "Claim did not succeed"
                    : "Checking your claim"}
                </h2>
                <p className="hash">Transaction: {claim.pending.hash}</p>
                <p className="hint">
                  Saved for recovery after reload. We never submit a replacement
                  automatically.
                </p>
                {claim.receipt.error && (
                  <p role="alert" className="error">
                    {claim.receipt.error.message}
                  </p>
                )}
                <button
                  className="secondary"
                  onClick={() =>
                    claim.settled
                      ? void claim.acknowledge()
                      : void claim.receipt.refetch()
                  }
                >
                  {claim.settled ? "Done" : "Check transaction"}
                </button>
              </div>
            )}
          </section>
          <section className="pack">
            <h2>Tokens in this airdrop</h2>
            <ul role="list">
              {config.tokens.map((token) => (
                <li key={token.address}>
                  <div className="token-mark" aria-hidden="true">
                    {token.symbol.replace(/^t/, "").slice(0, 1)}
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
      <footer>
        Test tokens. Real transactions.{" "}
        <a href="https://docs.thruput.network/">Read the docs ↗</a>
      </footer>
    </div>
  );
}
