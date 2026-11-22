# NFT Drop

An ERC721 collection with a public mint, where thousands of mints can land in
the same block. It shows how to design storage so that concurrent
transactions merge instead of conflict. Read [Counter](../counter/README.md)
first; this example uses the same `Balance` type.

The [NFT Drop factory](../nft-drop-factory/README.md) deploys one of these
contracts for each drop. The [NFT Drop app](../../apps/nft-drop/README.md)
creates drops, mints with a wallet, and simulates thousands of users minting at
once.

## Try it

From the repository root, after [setup](../../README.md#setup):

```sh
cargo test -p nft-drop --locked
thruput build -p nft-drop
```

Expected: **9 tests pass**. One test mints 100 tokens from 100 callers in one
block; all of them land. Another mints 101 tokens against a supply of 100; the
101st is excluded when the block commits, and a later mint fails with
`SoldOut`. The expected exceptions can appear in the test output.

## How a mint avoids conflicts

Every transaction in a block reads the state from the end of the previous
block, and records changes. The runtime merges compatible changes and excludes
a transaction whose changes conflict. `mint` makes only changes that merge:

| Data | Storage | Change in `mint` | Why concurrent mints do not conflict |
| --- | --- | --- | --- |
| Supply left | `Balance` | Checked `decrease(1)` | Decreases merge. The runtime admits only as many as the start-of-block value covers, so the drop sells out exactly. |
| Token ID | `NNInt` counter, hashed with the drop address, the caller, and the transaction hash | `inc(1)` | No mint reads and rewrites a shared "next ID". |
| Owner and traits of a token | `Value` at a new key | Exclusive `set` | Each token has its own keys, so the lock blocks no other mint. |
| Tokens per owner | `Balance` | `lazy_increase(1)` | Increases merge. |
| Count for each trait value | `Balance` | `lazy_increase(1)` | Every mint increases these few keys, and the increases merge. |

The supply uses a *checked* decrease, so a mint after sell-out fails at once
with a clear `SoldOut` error. The counts use *lazy* increases, because they
need no load and no early error.

## Why token IDs are not 1, 2, 3

Most EVM NFT contracts number tokens with a counter:

```solidity
uint256 id = totalSupply;
totalSupply += 1;
```

On Thruput, every such mint reads the same snapshot value and writes a new
absolute value to the same key. Two different values for one key conflict, so
**only one mint can land in each block**. At about 2 seconds per block, 10,000
mints would take about 5.5 hours. If the counter writes are not exclusive, it
is worse: mints that read the same snapshot write the *same* value, those equal
writes merge, and concurrent mints get the same ID.

This is a difference between two contract designs, not between two chains.
Parallel execution helps only when the data model lets concurrent writes
merge. Here, the ID is a hash, and the only shared values are counts that
merge.

The native tests report a zero transaction hash for every transaction. The ID
also hashes the caller, so same-block mints by different callers stay distinct
in `cargo test`. On a node, the transaction hash alone separates them; see
[`helpers/unique-ids`](../../helpers/unique-ids/src/lib.rs).

## Rules

- `initialize(creator, definition)` runs once, in the transaction that deploys
  the drop. The factory does this. Minting opens in the next block.
- Anyone can mint, any number of times, until the supply runs out.
- Each trait value has a weight. The roll hashes the token ID with the trait
  index, so a value with 1% of the total weight appears in about 1% of tokens.
  Rarity is a probability, not an exact count.
- `token_metadata` returns on-chain metadata: the drop name with a short ID,
  and a list of traits. It is built when it is read, so it costs no storage.
  The app draws the image from the traits.
- The ERC721 methods (transfers, approvals, operators, and safe transfers)
  follow the `erc721` fixture in `thruput-sdk-rs`, and `supports_interface`
  reports `ERC721` and `ERC721Metadata`.

Limits are part of the ABI: a supply of 1–10,000; a name of 1–100 UTF-8 bytes;
a symbol of 1–10 bytes; 1–6 traits; 2–8 values for each trait; trait and value
names of 1–24 bytes, unique in their list; and weights of 1–10,000.

## Known limits

- **Predictable traits.** A minter knows its own transaction hash, so it can
  sign many candidate transactions and submit one with rare traits. A drop
  that needs fair rarity must use a source of randomness that the minter
  cannot predict, for example commit and reveal.
- **Storage funding.** The drop pays the storage deposit for each token, about
  37,000 raw native-token units on a local node, and the factory requires a
  little more than that from the creator. While the node assembles a block, it
  holds more funding for each mint than the mint finally spends. So a large
  burst against one drop can spread over a few blocks: an excluded mint
  succeeds when its sender resubmits it. The supply cap is not affected.

## Exercise

Limit each wallet to one mint. Add a `Map<ContractAddress, Value<bool>>` and
write the caller's entry with `set_exclusive`, as
[Airdrop](../airdrop/src/implementation.rs) does for claims. Add a test in which
one caller mints twice in the same block: the second mint is excluded.
