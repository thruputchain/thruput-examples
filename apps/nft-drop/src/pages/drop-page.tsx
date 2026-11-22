import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient, useWallet } from "@thruputchain/react";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import type { FixedBytes } from "@thruputchain/client/contract";
import { Link, useParams } from "react-router-dom";
import { Critter } from "../art/critter";
import {
  oneIn,
  percent,
  share,
  tier,
  tokenTier,
  type TraitShape,
} from "../art/rarity";
import { errorMessage, type AppConfig } from "../config";
import {
  MINT_GAS,
  MINT_ROOT_GAS,
  NftDrop,
  readDrop,
  recentMints,
  type Mint,
} from "../contracts/drops";
import { RushPanel } from "../rush/rush-panel";
import { isActive, useRush } from "../rush/use-rush";
import type { Transaction } from "../transactions/use-transaction";

const short = (text: string) => `${text.slice(0, 6)}…${text.slice(-4)}`;

export function DropPage({
  config,
  transaction: tx,
}: {
  config: AppConfig;
  transaction: Transaction;
}) {
  const { address: param = "" } = useParams();
  let address: ReturnType<typeof addressFromBase58> | null = null;
  try {
    address = addressFromBase58(param);
  } catch {
    address = null;
  }
  if (!address)
    return (
      <p>
        That is not a drop address. <Link to="/">See all drops</Link>
      </p>
    );
  return (
    <Drop key={param} config={config} transaction={tx} address={address} />
  );
}

function Drop({
  config,
  transaction: tx,
  address,
}: {
  config: AppConfig;
  transaction: Transaction;
  address: ReturnType<typeof addressFromBase58>;
}) {
  const client = useClient();
  const wallet = useWallet();
  const { rush } = useRush();
  const base58 = toBase58(address);
  // Refresh quickly while a rush runs on this drop.
  const live = isActive(rush) && rush?.drop === base58;
  const queries = useQueryClient();
  // Read the final counts and mints as soon as a rush on this drop finishes.
  useEffect(() => {
    if (rush?.drop === base58 && rush.phase === "done")
      void queries.invalidateQueries({ queryKey: ["nft-drop"] });
  }, [rush?.id, rush?.phase]);
  const [mine, setMine] = useState(false);
  const owner =
    mine && wallet.address ? addressFromBase58(wallet.address) : undefined;

  const drop = useQuery({
    queryKey: ["nft-drop", "drop", base58],
    queryFn: () => readDrop(client, address),
    refetchInterval: live ? 1_000 : 5_000,
  });
  const mints = useQuery({
    queryKey: ["nft-drop", "mints", base58, owner ? toBase58(owner) : "all"],
    queryFn: () => recentMints(client, address, owner),
    refetchInterval: live ? 1_500 : 5_000,
  });

  if (drop.error)
    return (
      <p role="alert">
        {errorMessage(drop.error)} <Link to="/">See all drops</Link>
      </p>
    );
  if (!drop.data) return <p className="muted">Loading the drop…</p>;
  const { config: dropConfig, traits, counts, remaining } = drop.data;
  const minted = dropConfig.supply - remaining;
  const justMinted =
    tx.completed?.label === "Mint" && tx.completed.ok
      ? (tx.completed.values[0] as FixedBytes<32> | undefined)
      : undefined;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{dropConfig.symbol} · ERC721</p>
          <h1>{dropConfig.name}</h1>
          <p className="muted mono break-all">
            {base58} · created by {short(toBase58(dropConfig.creator))}
          </p>
        </div>
      </div>

      <section className="supply panel" aria-label="Supply">
        <div className="supply-numbers">
          <p>
            <span className="big mono">{minted.toLocaleString()}</span>
            <span className="muted">
              {" "}
              / {dropConfig.supply.toLocaleString()} minted
            </span>
          </p>
          <p className="muted mono">
            {remaining === 0n
              ? "Sold out"
              : `${remaining.toLocaleString()} left`}
          </p>
        </div>
        <progress max={Number(dropConfig.supply)} value={Number(minted)} />
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={
              wallet.status !== "connected" || tx.blocked || remaining === 0n
            }
            onClick={() =>
              void tx.send(
                "Mint",
                [NftDrop.v0_1.mint.call({ address, gasLimit: MINT_GAS })],
                MINT_ROOT_GAS,
              )
            }
          >
            Mint one
          </button>
          {wallet.status !== "connected" ? (
            <span className="muted">Connect a wallet to mint.</span>
          ) : null}
        </div>
        {justMinted ? (
          <JustMinted address={address} tokenId={justMinted} traits={traits} />
        ) : null}
      </section>

      <RushPanel drop={base58} crowdSize={config.crowdSize} />

      <section className="panel" aria-labelledby="rarity-heading">
        <h2 id="rarity-heading">Rarity</h2>
        <p className="muted">
          The target is each value's chance. The actual share comes from the
          tokens minted so far.
        </p>
        <div className="rarity">
          {traits.map((trait, t) => {
            const total = counts[t]!.reduce((sum, n) => sum + n, 0n);
            return (
              <table key={trait.name}>
                <caption>{trait.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Value</th>
                    <th scope="col">Target</th>
                    <th scope="col">Minted</th>
                    <th scope="col">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {trait.values.map((value, v) => {
                    const count = counts[t]![v]!;
                    return (
                      <tr key={value.name}>
                        <td>
                          <span
                            className="tier"
                            data-tier={tier(share(trait, v))}
                          />{" "}
                          {value.name}
                        </td>
                        <td className="mono">{percent(share(trait, v))}</td>
                        <td className="mono">{count.toLocaleString()}</td>
                        <td className="mono">
                          {total ? percent(Number(count) / Number(total)) : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })}
        </div>
      </section>

      <Gallery
        traits={traits}
        mints={mints.data ?? []}
        error={mints.error}
        mine={mine}
        canFilter={wallet.status === "connected"}
        onMine={setMine}
      />
    </>
  );
}

function JustMinted({
  address,
  tokenId,
  traits,
}: {
  address: ReturnType<typeof addressFromBase58>;
  tokenId: FixedBytes<32>;
  traits: TraitShape[];
}) {
  const client = useClient();
  const rolled = useQuery({
    queryKey: ["nft-drop", "token", toBase58(tokenId)],
    queryFn: () =>
      NftDrop.v0_1.traitsOf
        .view({ client, address, args: { tokenId } })
        .then((r) => Array.from(r.value)),
    retry: 5,
    retryDelay: 1_000,
  });
  return (
    <div className="just-minted" role="status">
      {rolled.data ? (
        <Critter traits={traits} rolled={rolled.data} size={96} />
      ) : null}
      <div>
        <p>You minted a token.</p>
        <p className="mono muted break-all">{toBase58(tokenId)}</p>
        {rolled.data ? (
          <p className="muted">
            1 in {oneIn(traits, rolled.data).toLocaleString()}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Gallery({
  traits,
  mints,
  error,
  mine,
  canFilter,
  onMine,
}: {
  traits: TraitShape[];
  mints: Mint[];
  error: Error | null;
  mine: boolean;
  canFilter: boolean;
  onMine: (mine: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState<Mint | null>(null);
  return (
    <section aria-labelledby="gallery-heading" className="gallery">
      <div className="section-heading">
        <h2 id="gallery-heading">Latest mints</h2>
        {canFilter ? (
          <div className="actions" role="group" aria-label="Filter">
            <button
              type="button"
              className="small"
              aria-pressed={!mine}
              onClick={() => onMine(false)}
            >
              Everyone
            </button>
            <button
              type="button"
              className="small"
              aria-pressed={mine}
              onClick={() => onMine(true)}
            >
              Minted by me
            </button>
          </div>
        ) : null}
      </div>
      {error ? <p role="alert">{errorMessage(error)}</p> : null}
      {mints.length === 0 && !error ? (
        <p className="empty">No mints to show yet.</p>
      ) : null}
      <ul className="token-grid">
        {mints.map((mint) => (
          <li key={mint.tokenId}>
            <button
              type="button"
              className="token"
              data-tier={tokenTier(traits, mint.traits)}
              onClick={() => {
                setOpen(mint);
                dialog.current?.showModal();
              }}
            >
              <Critter traits={traits} rolled={mint.traits} size={120} />
              <span className="mono muted">{short(mint.tokenId)}</span>
            </button>
          </li>
        ))}
      </ul>
      <dialog
        ref={dialog}
        className="token-dialog"
        onClose={() => setOpen(null)}
      >
        {open ? (
          <>
            <Critter traits={traits} rolled={open.traits} size={240} />
            <div className="token-details">
              <h2>Token {short(open.tokenId)}</h2>
              <p className="muted">
                1 in {oneIn(traits, open.traits).toLocaleString()}
              </p>
              <dl>
                {traits.map((trait, t) => {
                  const v = open.traits[t] ?? 0;
                  return (
                    <div key={trait.name}>
                      <dt className="muted">{trait.name}</dt>
                      <dd>
                        {trait.values[v]?.name}{" "}
                        <span className="mono muted">
                          {percent(share(trait, v))}
                        </span>
                      </dd>
                    </div>
                  );
                })}
                <div>
                  <dt className="muted">Owner</dt>
                  <dd className="mono break-all">{open.owner}</dd>
                </div>
                <div>
                  <dt className="muted">Block</dt>
                  <dd className="mono">{open.blockHeight.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="muted">Transaction</dt>
                  <dd className="mono break-all">{open.transactionHash}</dd>
                </div>
              </dl>
              <form method="dialog">
                <button type="submit">Close</button>
              </form>
            </div>
          </>
        ) : null}
      </dialog>
    </section>
  );
}
