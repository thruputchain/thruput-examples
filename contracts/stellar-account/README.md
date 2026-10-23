# Stellar-classic account

An example (not for production) of Stellar classic's account model on Thruput: a master key,
up to 20 additional weighted signers, low/medium/high operation thresholds, and a few iconic
operations. The point is that Thruput's protocol already carries this model at the address
level, so the contract adds the thresholds and nothing else.

- [`stellar-account`](src/account.rs): the account. Tested on the native executor in
  [`tests/account.rs`](tests/account.rs) and on a devnode in
  [`tests/testkit_account.rs`](tests/testkit_account.rs) (`#[ignore]`d).
- [`stellar-account-factory`](../stellar-account-factory/): deploys an account at an address that
  is a function of its master key and initializes it in the same frame.
- [`stellar-account-factory-if`](../../interfaces/stellar-account-factory-if/): the factory and
  initializer traits, and the address derivation.

## Stellar to Thruput

| Stellar | Here |
|---|---|
| Account ID (`G...`) | The master key, fixed at creation; `master_key()` returns it. The CLI formats it as the same `G` strkey. |
| Account address | `factory.address_of(G)`: a hash of the factory, a domain-tagged hash of `G`, and the account code hash. |
| Master key weight | `set_master_weight(w)`; 0 deregisters slot 0. |
| Up to 20 signers | Slots 1 to 20, `set_signer(slot, key, weight)` / `remove_signer(slot)`. `key` is an Ed25519 or ML-DSA-65 `PublicKey`. The client picks the slot by reading `AddressAuthData` over RPC. |
| Low / medium / high thresholds | `set_thresholds(low, medium, high)`. `low` is also the chain-enforced required weight. |
| Operation threshold check | The transaction's auth claim asks for a `required_weight`; hogd admits the transaction only if the signers' weights reach it; the account requires that claimed weight to reach the operation's threshold. |
| `payment` | `payment(asset, to, amount)`: an ERC20 transfer. The native token is the ERC20 at the precompile address. |
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

## Post-quantum signers

Stellar signers are Ed25519 keys (`G...`). Here any signer slot can instead hold an ML-DSA-65
(FIPS 204) key, and one account can mix the two: a transaction's signatures are checked per slot
against that slot's scheme, and their weights add up as usual. The master key is always Ed25519,
so the account ID and address derivation are unchanged.

An ML-DSA-65 key has no `G`/`S` strkey form; clients pass it as a scheme-tagged `PublicKey`. It
travels only as `set_signer` calldata and goes straight into the chain's registration: the account
never stores, emits, or returns it (`SignerChanged` carries the slot and weight). That keeps the
account within the chain's default 1024-byte limits on a storage value, an event, and a return
buffer, which a 1953-byte encoded ML-DSA-65 key would exceed. Read a signer's key back from the
address's `AddressAuthData`.

Needs a `thruput-sdk` whose `add_address_public_key` accepts ML-DSA-65 keys and a runtime with
hogd #4539; [`tests/account.rs`](tests/account.rs) covers mixed Ed25519/ML-DSA-65 authorization
against the native executor's verifier.

## What is not Stellar here

No sequence numbers (the transaction uniquifier covers replay). No trustlines or non-native
assets beyond ERC20 addresses. No data entries, flags, home domain, sponsorship, pre-auth or
hash-x signers. No Stellar XDR envelopes: transactions are Thruput transactions signed by the
registered keys. The master key cannot take a second slot (refused in-frame, `InvalidSlot`). The
chain refuses any registration that would place one key in two slots of an address (hogd
`DuplicateSigner` conflict), so such a transaction fails to commit; the account cannot read other
slots' keys back, so this guarantee is provided by the chain, not the contract (Stellar keys
signers by key, so a key can appear only once).
