# NFT Drop factory

Deploys one [NFT Drop](../nft-drop/README.md) contract for each drop. The
creator funds the drop's storage before the drop exists, and the factory keeps
a list of the drops it created.

## Try it

From the repository root, after [setup](../../README.md#setup):

```sh
cargo test -p nft-drop-factory --locked
thruput build -p nft-drop-factory
```

Expected: **6 tests pass**. They cover funded creation at the predicted
address, refusal of an underfunded drop, rollback of an invalid definition,
funding and creation in one transaction, and the limit of one creation for
each block.

## How creation works

1. The app asks `predict_drop(creator, nonce)` for the new drop's address, and
   `required_funding(supply)` for the native tokens its storage needs. The NFT
   Drop app's setup sets the rates so that a drop can mint its whole supply in
   one block (see the drop's [known limits](../nft-drop/README.md#known-limits)).
2. The creator's wallet sends one transaction with two calls: a native-token
   transfer to the predicted address, then `create_drop(nonce, definition)`.
3. `create_drop` checks the funding, deploys the drop with `deploy_contract`,
   and calls its `initialize` in the same transaction. An invalid definition
   aborts the transaction, so nothing is deployed and the funding transfer
   rolls back.

The factory calls the drop through the `NftDropClient` that the drop crate
generates, as [Cross-call](../cross-call/README.md) calls Fibonacci.

## Storage choices

| Data | Storage | Reason |
| --- | --- | --- |
| Drop code hash and funding rates | `Value<FactoryConfig>` | Set once at deployment. |
| Number of drops | `NNInt` | Creation reads it and writes the next value, so creation is serialized: one drop per block. Drops are rare, and minting never touches the factory. |
| Drop addresses | `Map<u64, Value<ContractAddress>>` with `set_exclusive` | The exclusive write is what excludes a second creation in the same block. Apps read the list with `drop_count` and `drop_at`. |

Compare Launchpad's token factory, which writes no shared state, because token
launches are frequent. Its app indexes events instead of reading a list.

## Exercise

Add a `creation_fee` to `FactoryConfig`, collected with an allowance on the
native token, as the [standard token factory](../standard-token-factory/src/implementation.rs)
does. Remember that an allowance granted in a block cannot be spent in that
block.
