# NFT Drop app

Create NFT drops, mint with a wallet, and start a **rush**: thousands of
simulated users mint at the same time. The live view shows the result. On a
local node, 10,000 mints sent at once land in **one block**, the supply sells
out exactly, and no mint conflicts with another.

Each drop is an ERC721 collection from the [NFT Drop](../../contracts/nft-drop/README.md)
contract, created by the [NFT Drop factory](../../contracts/nft-drop-factory/README.md).

## Why the number matters

Most EVM NFT contracts number tokens with a shared counter (`id = totalSupply++`).
On Thruput, every such mint writes a new value to the same key, so only one mint
could land in each block: 10,000 mints at about 2 seconds per block would take
about 5.5 hours. This drop has no shared counter. Its supply cap is a `Balance`
whose decreases merge, and its token IDs are hashes. So every mint in a block
can land together.

That is a difference between two contract designs, not between two chains.
Parallel execution helps only when the data model lets concurrent writes merge.
The [contract README](../../contracts/nft-drop/README.md#how-a-mint-avoids-conflicts)
explains each storage choice.

## Run it

Complete [root setup](../../README.md#setup), and start a local node:

```sh
thruput node --port 9545 --json
```

In another terminal, from the repository root:

```sh
npm run setup:local --workspace apps/nft-drop
npm run dev --workspace apps/nft-drop
```

Open **http://127.0.0.1:5178**. Setup takes about three minutes. It:

1. builds both contracts and regenerates their bindings;
2. switches the node to 2-second interval blocks with `dev_setBlockDriver`. A new
   local node makes one block for each transaction, which would put every mint
   in its own block;
3. funds an operator from the faucet, then deploys the factory;
4. creates the **Thruput Critters** demo drop with 10,000 tokens. The node keeps
   a contract's code only after a transaction deploys it, so this first
   creation attaches the drop's code. Later drops deploy by code hash;
5. funds 10,000 simulated users (the crowd) in batches of 16 transfers. Each
   account gets 0.05 native tokens to schedule mints, about 513 in all; the
   local faucet supplies them;
6. writes `.env.local`, including the private `NFT_CROWD_SEED` that derives every
   crowd key.

Each run saves its records under `.local/nft-drop-setup/`: the operator key,
signed transactions, and outcomes. Setup does not resend a transaction after a
timeout. A failed run keeps the previous `.env.local`. After you restart the
node, run setup again.

To start a rush, open the demo drop, choose the users and the window, and click
**Start rush**. **All at once** sends every mint immediately. To create drops or
mint with a wallet, install [Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/),
select the same local node, and request test tokens. A 10,000-token drop needs
about 40 native tokens for storage; a 100-token drop needs about 0.5.

Overrides: `THRUPUT_RPC_URL` (default `http://127.0.0.1:9545`), `NFT_CROWD_SIZE`
(1–10,000, default 10,000), `NFT_DROP_APP_ENV` (output file), and the optional
network checks `THRUPUT_NETWORK_ID` and `THRUPUT_RUNTIME_MANIFEST`.

## Where the Thruput code is

- [`server/rush.ts`](server/rush.ts): the rush. It signs one mint for each crowd
  account, submits them through batched JSON-RPC, observes each original hash,
  resubmits the same signed mint after an exclusion, and sorts the outcomes.
- [`src/contracts/drops.ts`](src/contracts/drops.ts): every read. Views run in
  batches of 16, and mints come from `TraitsRolled` events.
- [`src/transactions/use-transaction.ts`](src/transactions/use-transaction.ts):
  wallet writes. Creating a drop funds its predicted address and creates it in
  one atomic batch.
- [`scripts/index.ts`](scripts/index.ts): setup, including how a drop's storage
  funding is sized.

## Outcomes in the live view

| Outcome      | Meaning                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Minted       | The mint committed and returned a token.                                                                   |
| Sold out     | The mint committed with `SoldOut`: no supply was left at the start of its block.                           |
| Not included | The node dropped the mint, or a block still excluded it when the rush stopped watching. It did not commit. |
| Failed       | The mint committed with another failure.                                                                   |
| Pending      | No outcome yet.                                                                                            |

When a block excludes a mint, its status is `retry`, and the simulated user
does what a wallet does: it resubmits the same signed transaction. No new
transaction is signed, so a user's mint commits at most once. A block excludes
a mint for one of these reasons:

- **Sell-out.** The supply bound admits only as many mints as the start-of-block
  supply covers. A resubmitted mint then fails with `SoldOut`.
- **Storage funding.** While the node assembles a block, it holds more of the
  drop's storage funding for each mint than the mint finally spends. A large
  burst can therefore spread over a few blocks. The resubmitted mints land in
  the next blocks.
- **A conflict between mints.** The live view counts these. This design keeps
  the count at zero.

## What it leaves out on purpose

- **Fair randomness.** A minter can predict its traits. See the contract's
  [known limits](../../contracts/nft-drop/README.md#known-limits).
- **Transfers and a marketplace.** The contract implements ERC721 transfers and
  approvals; the app does not show them.
- **Devnet.** The rush and setup target a local node.
- **History.** The gallery shows mints that the node's event index still serves.
  Counts come from contract views and are always complete.

## Commands and checks

Run `npm run <command> --workspace apps/nft-drop`:

| Command                      | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `dev`                        | Vite UI with the rush API and read-only RPC proxy         |
| `setup:local`                | Build, deploy, and fund a fresh setup                     |
| `generate:contracts`         | Build both contracts and regenerate the bindings          |
| `typecheck`, `test`, `build` | Types, unit tests, and the production bundle              |
| `start`                      | Serve the production bundle on `PORT` (setup writes 3000) |

Root `npm run test:nft-drop` checks everything on an isolated node: setup,
creating a drop and minting with an injected test wallet, an exact sell-out,
and 300 simultaneous mints in one or two blocks. It requires Chromium. See
[checks and prerequisites](../../scripts/README.md#checks).
