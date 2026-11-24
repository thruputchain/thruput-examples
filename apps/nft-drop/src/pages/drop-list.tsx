import { useQuery } from "@tanstack/react-query";
import { useClient } from "@thruputchain/react";
import { toBase58 } from "@thruputchain/client";
import { Link } from "react-router-dom";
import { Artwork } from "../art/artwork";
import { roll, seeded } from "../art/rarity";
import { errorMessage, type AppConfig } from "../config";
import { listDrops, readDrop, type DropSummary } from "../contracts/drops";

export function DropList({ config }: { config: AppConfig }) {
  const client = useClient();
  const drops = useQuery({
    queryKey: ["nft-drop", "drops"],
    queryFn: () => listDrops(client, config.factory),
    refetchInterval: 5_000,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">NFT drops on Thruput</p>
          <h1>Thousands of mints at once, no conflicts</h1>
          <p className="muted">
            Each drop is an ERC721 collection. Mint one with your wallet, or
            start a rush of simulated users and watch their mints land together.
          </p>
        </div>
        <Link className="button primary" to="/new">
          New drop
        </Link>
      </div>
      {drops.error ? <p role="alert">{errorMessage(drops.error)}</p> : null}
      {drops.data?.length === 0 ? (
        <p className="empty">No drops yet. Create the first one.</p>
      ) : null}
      <ul className="drop-grid">
        {drops.data?.map((drop) => (
          <li key={toBase58(drop.address)}>
            <DropCard drop={drop} />
          </li>
        ))}
      </ul>
    </>
  );
}

function DropCard({ drop }: { drop: DropSummary }) {
  const client = useClient();
  const address = toBase58(drop.address);
  // The card's sample uses the drop's traits, seeded by its address.
  const details = useQuery({
    queryKey: ["nft-drop", "drop", address],
    queryFn: () => readDrop(client, drop.address),
  });
  const minted = drop.config.supply - drop.remaining;
  return (
    <Link className="drop-card" to={`/drops/${address}`}>
      <div className="art-frame">
        {details.data ? (
          <Artwork
            traits={details.data.traits}
            rolled={roll(details.data.traits, seeded(drop.address))}
            seed={address}
            size={240}
            label={`Sample from ${drop.config.name}`}
          />
        ) : null}
      </div>
      <div className="drop-card-body">
        <p className="eyebrow">{drop.config.symbol}</p>
        <h2>{drop.config.name}</h2>
        <progress max={Number(drop.config.supply)} value={Number(minted)} />
        <p className="muted mono">
          {minted.toLocaleString()} / {drop.config.supply.toLocaleString()}{" "}
          minted
        </p>
      </div>
    </Link>
  );
}
