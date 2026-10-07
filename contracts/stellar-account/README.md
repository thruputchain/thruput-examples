# Stellar-classic account

An example (not for production) of Stellar classic's account model on Groundhog: a master key,
up to 20 additional weighted signers, low/medium/high operation thresholds, and a few iconic
operations. The point is that Groundhog's protocol already carries this model at the address
level, so the contract adds the thresholds and nothing else.

- [`stellar-account`](src/account.rs): the account. Tested on the native executor in
  [`tests/account.rs`](tests/account.rs) and on a devnode in
  [`tests/testkit_account.rs`](tests/testkit_account.rs) (`#[ignore]`d).
- [`stellar-account-factory`](../stellar-account-factory/): deploys an account at an address that
  is a function of its master key and initializes it in the same frame.
- [`stellar-account-factory-if`](../../interfaces/stellar-account-factory-if/): the factory and
  initializer traits, and the address derivation.

## Stellar to Groundhog

| Stellar | Here |
|---|---|
| Account ID (`G...`) | The master key, fixed at creation; `master_key()` returns it. The CLI formats it as the same `G` strkey. |
| Account address | `factory.address_of(G)`: a hash of the factory, a domain-tagged hash of `G`, and the account code hash. |
| Master key weight | `set_master_weight(w)`; 0 deregisters slot 0. |
| Up to 20 signers | Slots 1 to 20, `set_signer(slot, key, weight)` / `remove_signer(slot)`. The client picks the slot by reading `AddressAuthData` over RPC. |
| Low / medium / high thresholds | `set_thresholds(low, medium, high)`. `low` is also the chain-enforced required weight. |
| Operation threshold check | The transaction's auth claim asks for a `required_weight`; hogd admits the transaction only if the signers' weights reach it; the account requires that claimed weight to reach the operation's threshold. |
| `payment` | `payment(asset, to, amount)`: an ERC20 transfer. Native HOG is the ERC20 at the precompile address. |
| `create_account` with starting balance | `create_account(factory, G, starting_balance)`: pays the balance to the predicted address, then the factory deploys and initializes. hogd charges deployment storage to the deployed address, which is why the balance is required. |
| Any other operation | `invoke(target, entrypoint, gas_limit, calldata)`: raw passthrough. |

Signer and threshold changes are high threshold; everything else is medium; low is stored but
unused by any shipped operation. A change that would leave the summed weights below any of the
three thresholds, or any threshold below 1, is refused (`WouldLockOut`). `low` matters most: it is
the chain-enforced required weight, so above the total weight it would keep the chain from
admitting any transaction for the account again.

Every operation must be the transaction's root invocation. The auth claim is verified against the
invoked address's registration, so a claim observed from another contract's frame says nothing
about this account's signers.

Registration writes land with the block: a signer change is in force from the next block, and a
transaction sharing a block with the change is judged against the old set.

## What is not Stellar here

No sequence numbers (the transaction uniquifier covers replay). No trustlines or non-native
assets beyond ERC20 addresses. No data entries, flags, home domain, sponsorship, pre-auth or
hash-x signers. No Stellar XDR envelopes: transactions are Groundhog transactions signed by the
registered keys. The master key cannot take a second slot (refused in-frame, `InvalidSlot`). The
chain refuses any registration that would place one key in two slots of an address (hogd
`DuplicateSigner` conflict), so such a transaction fails to commit; the account cannot read other
slots' keys back, so this guarantee is provided by the chain, not the contract (Stellar keys
signers by key, so a key can appear only once).
