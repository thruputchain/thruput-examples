# Stellar-Classic Account Example

Status: Implemented (live devnode test not yet executed)
Date: 2026-09-30

A pair of example contracts, `stellar-account` and `stellar-account-factory`, plus the factory's
interface crate, that reproduce Stellar classic's account model on Groundhog: a master key, up to
20 additional weighted signers, low/medium/high operation thresholds, and a few iconic operations
(`payment`, `create_account`, signer management). The point is to show that the protocol's native
weighted-key authorization already carries Stellar's semantics, and that a Stellar `G...` key maps
to a Groundhog account address and back.

## What the protocol already provides

Every Groundhog address carries an `AddressAuthData`: up to `kMaxSigners = 21` weighted public keys
and one `required_weight`. A transaction's `AuthClaim::kSourceAddressAuthData` names an
`allowed_keys` bitmap and a `required_weight`. hogd admits the transaction only if the signers'
summed weights reach `max(stored required_weight, claimed required_weight)`
(`hogd/auth_claim/verify.cc`). Inside a contract, the SDK exposes:

| SDK function | Syscall | Acts on |
|---|---|---|
| `get_auth_claim()` | `GetAuthClaim` | the current transaction |
| `add_address_public_key(slot, key, weight)` | `ChangePublicKeyRegistration` | the executing contract's own address |
| `remove_address_public_key(slot)` | `ChangePublicKeyRegistration` | same |
| `set_address_required_weight(w)` | `WriteAddressRequiredWeight` | same |

There is no syscall that reads an address's registration back. The account therefore mirrors the
one thing it needs for its own checks (per-slot weights) and nothing else.

A G key (ed25519) also owns a native "pubkey account" at
`sha256(DomainSeparator("PubkeyAccount") || preimage)`, served by hogd's default-wallet precompile.
The CLI already formats ed25519 keys as Stellar `G` strkeys and contract addresses as `C` strkeys
(`groundhog-signing/src/strkey.rs`), so "the G-address" is literally Stellar's encoding of the
master key.

## Approach

**Claim-weight gating.** The chain keeps verifying signatures. The account stores Stellar's three
thresholds and pins the chain-enforced `required_weight` to the low threshold. Every
state-changing entry point then checks that (1) it is the root invocation and (2) the
transaction's claimed `required_weight` is at least the threshold for that operation's category.
Since hogd already required the signers to sum to the claimed weight, (2) is the complete Stellar
threshold check, with no signature handling in the contract.

Rejected alternatives: the account verifying signatures itself (duplicates the chain, needs its own
replay cache; only worthwhile if Stellar-signed envelopes must be accepted later, and it can be
added as a second entry path on the same storage), and a single threshold with no categories (not
recognizably Stellar, loses high-threshold protection on signer changes).

## Crates

| Crate | Path | Role |
|---|---|---|
| `stellar-account` | `contracts/stellar-account` | The account contract. One instance per master key. |
| `stellar-account-factory` | `contracts/stellar-account-factory` | Deterministic deployment plus same-frame initialization. |
| `stellar-account-factory-if` | `interfaces/stellar-account-factory-if` | Factory trait, generated client, and the pure address-derivation helper. |

All three follow the existing crate conventions: `#![cfg_attr(not(feature = "dev"), no_std)]`,
`sdk::declare_mock_contract!()`, an `entrypoints` bin wrapper in `src/main.rs`, `dev` feature
pulling `thiserror`, `publish = false` via the workspace.

## Address derivation

The factory deploys an account with a domain-tagged hash of the master key (`deployment_nonce`,
domain `groundhog-stellar-account-factory-v1`) as the deployment nonce, and its configured
account code hash, so:

```
account_address(G) = get_deploy_address_for_other(factory, deployment_nonce(G), account_code_hash)
```

Forward direction: `factory.address_of(G)` on-chain, and the same function exported from the
interface crate for tests and clients. Reverse direction: `account.master_key()`.

As in Stellar, the master key is the account's identity and is never replaced: slot 0 holds the
creation key for the life of the account, and only its weight can change (including to 0, which
deregisters it). `master_key()` always reports the creation key, whether or not slot 0 is currently
registered.

## Creation flow

1. A creator pays at least the factory's `required_funding` in native HOG to `address_of(G)`.
   hogd charges deployment storage to the deployed address, which is why the prefund is required;
   it is also exactly Stellar's starting balance.
2. The creator calls `factory.create_account(G)`. The factory predicts the address, checks the
   native balance, deploys, asserts the deployed address equals the prediction, calls
   `initialize(G)` on the new account before its frame ends, and emits `AccountCreated`.
3. `initialize` registers `G` at slot 0 with weight 1, sets the chain's `required_weight` to 1,
   sets all three thresholds to 1, sets the weight mirror to `[1, 0, ...]`, and refuses a second
   call.

Anyone may call `create_account`; the account's own `create_account` operation is the Stellar op
and performs steps 1 and 2 in one frame.

The factory has no creation fee, no fee recipient, and no administrator beyond its one-shot
`initialize`.

## Account storage

```rust
#[contract_type]
pub struct Thresholds { pub low: u32, pub medium: u32, pub high: u32 }

#[contract_type]
pub struct AccountConfig {
    pub master_key: Ed25519PublicKey, // immutable after initialize
    pub thresholds: Thresholds,      // each >= 1, invariant enforced on every write
    pub weights: [u32; 21],          // mirror of each slot's registered weight; 0 = empty
}

#[sdk::storage]
pub struct StellarAccount {
    config: Value<AccountConfig>,
}
```

Keys other than the master are never stored; they live only in the chain's registration. The
weight mirror cannot drift because only the account itself can change its own registration.

## Threshold enforcement

Preamble shared by every state-changing entry point, parameterized by category:

1. **Root invocation.** `sys::raw_GetMsgSender` must fail with `kSyscallErrorCodeIsRootTransaction`
   (the same test hogd's `dev_wallet` uses). Otherwise throw `NotRootInvocation`. The auth claim is
   verified against the *invoked* address's registration, so a claim observed from a child frame
   says nothing about this account's signers.
2. **Claim weight.** `get_auth_claim()` must be `kSourceAddressAuthData` with
   `required_weight >= thresholds[category]`. Otherwise throw `InsufficientAuthWeight`. The
   `allowed_keys` bitmap is not inspected; any registered signer counts, as in Stellar.

Categories:

| Category | Operations |
|---|---|
| High | `set_signer`, `remove_signer`, `set_master_weight`, `set_thresholds` |
| Medium | `payment`, `create_account`, `invoke` |
| Low | none shipped; stored and settable for fidelity |

The chain-enforced `required_weight` is always written equal to `thresholds.low`.

**Lockout guard.** After applying any signer or threshold change (the account's private `commit`
step, which every high-threshold entry point ends with), require `min(low, medium, high) >= 1` and
`sum(weights) >= max(low, medium, high)`; otherwise throw `WouldLockOut` and revert, including any
registration syscall already issued. Every category must stay satisfiable. `low` is the one that
cannot be recovered from: it is the chain-enforced required weight, so a `low` above the total
weight would keep hogd from ever admitting another transaction for the account, and a `low` of 0
would let an unsigned transaction clear it. An unreachable `medium` would only disable payments
until a high-threshold fix, but there is no reason to allow it.

**Timing.** Registration writes land with the block. A signer change is in force from the next
block; a transaction sharing a block with the change is judged against the old set. Same caveat
`permit-wallet` documents for key rotation.

## Account entry points

High threshold:

- `set_signer(slot: u32, key: Ed25519PublicKey, weight: u32)`: `1 <= slot < 21`, `weight >= 1`
  (`InvalidSlot`, `ZeroWeight`). Registers or replaces the key at `slot`, updates the mirror, runs
  the guard. Slot 0 is refused: the master key cannot be replaced. The master key itself is refused
  in any other slot (`InvalidSlot`): it already owns slot 0, and a second slot would count its
  weight twice. The chain refuses any registration that would place one key in two slots of an
  address (hogd `DuplicateSigner` conflict), so such a transaction fails to commit; the account
  cannot read other slots' keys back, so this guarantee is provided by the chain, not the contract.
  Emits `SignerChanged { slot, weight }`.
- `remove_signer(slot: u32)`: `1 <= slot < 21` (`InvalidSlot`). Deregisters, zeros the mirror
  entry, runs the guard. Emits `SignerChanged { slot, weight: 0 }`.
- `set_master_weight(weight: u32)`: Stellar's master weight. `weight >= 1` re-registers the stored
  master key at slot 0 with that weight; `weight == 0` deregisters slot 0 (`InvalidSlot` if slot 0
  is already empty). Updates the mirror, runs the guard. Emits `SignerChanged { slot: 0, weight }`.
- `set_thresholds(low: u32, medium: u32, high: u32)`: stores, writes `low` as the chain's required
  weight, runs the guard. Emits `ThresholdsChanged { low, medium, high }`.

Medium threshold:

- `payment(asset: ContractAddress, to: ContractAddress, amount: Amount)`: ERC20 `transfer` from the
  account via `groundhog-erc20-if`. Native HOG is the ERC20 at
  `sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN`, so one entry point covers both.
- `create_account(factory: ContractAddress, master_key: Ed25519PublicKey, starting_balance: Amount) -> ContractAddress`:
  reads the factory's `config()`, derives the address locally with `account_address` and the
  configured code hash, pays `starting_balance` of the configured native token to it, calls the
  factory's `create_account`, and throws `CallFaulted` unless the factory returns that same
  address. One frame.
- `invoke(target: ContractAddress, entrypoint: ContractEntrypointID, gas_limit: u64, calldata: BytesM) -> BytesM`:
  raw passthrough via `sdk::call::contract_call`. Returns the child's bytes on `Return`; on `Abort`
  re-aborts with the child's payload; on a fault throws `CallFaulted`. No auth tokens are forwarded
  and returned token ids are discarded.

Views (no preamble): `master_key() -> Ed25519PublicKey`, `thresholds() -> Thresholds`,
`signer_weights() -> [u32; 21]`.

One-shot: `initialize(master_key)`, open to any caller but intended to run in the factory's frame,
throws `AlreadyInitialized` on a second call. The same "deploy and initialize in one frame"
reasoning as `permit-wallet` applies.

## Factory entry points

- `initialize(config: FactoryConfig)`: once; `required_funding >= 1` else `InvalidConfig`.
  `FactoryConfig { account_code_hash: SHA256Hash, native_token: ContractAddress, required_funding: Amount }`.
  `Amount = i128` re-exported from `groundhog-erc20-if`.
- `create_account(master_key: Ed25519PublicKey) -> ContractAddress`: as in the creation flow.
  Throws `InsufficientFunding` if the predicted address holds less than `required_funding`,
  `AddressMismatch` if the deployed address differs from the prediction.
- `address_of(master_key: Ed25519PublicKey) -> ContractAddress`: view.
- `config() -> FactoryConfig`: view; returns the immutable configuration.

The interface crate exports the trait, the generated `StellarAccountFactoryClient`, and
`fn account_address(factory: &ContractAddress, code_hash: &SHA256Hash, master_key: &Ed25519PublicKey) -> ContractAddress`
built on `get_deploy_address_for_other`, plus a `dev`-only pure-Rust equivalent for off-chain use,
`account_address_offchain` (same preimage as `groundhog-signing::derive_deploy_address`; the nonce
is hashed in-process with `sha2` because the SDK's hash is a syscall).

## Errors

Account (`#[contract_exception] #[non_exhaustive]`, `thiserror` under `dev`):
`NotRootInvocation = 1`, `InsufficientAuthWeight = 2`, `InvalidSlot = 3`, `ZeroWeight = 4`,
`WouldLockOut = 5`, `CallFaulted = 6`. A child abort inside `invoke` is not an account error:
the child's own abort payload is re-raised verbatim. `remove_signer` on an empty slot,
`set_master_weight(0)` on an empty slot 0, and `set_signer` with the master key are `InvalidSlot`.

> `AccountInitError::AlreadyInitialized = 1` lives in the interface crate with the initializer
> trait.

Factory: `AlreadyInitialized = 1`, `InvalidConfig = 2`, `InsufficientFunding = 3`,
`AddressMismatch = 4`.

## Events

Account: `SignerChanged { slot: u32, weight: u32 }`, `ThresholdsChanged { low, medium, high }`.
Factory: `AccountCreated { account: ContractAddress, master_key: Ed25519PublicKey }`.
Together these let an indexer reconstruct the signer set without a read syscall.

## Testing

**Native, `contracts/stellar-account/tests/account.rs`.** The mock environment attaches an
arbitrary claim via `env.transaction().with_auth_claim(..).transact(..)` and does not verify
signatures, so the claimed weight is the whole input to the threshold check:

- `payment` with claimed weight equal to medium succeeds; below medium throws
  `InsufficientAuthWeight`.
- `set_signer` at medium is refused; at high it succeeds, and `signer_weights` and the
  `SignerChanged` event reflect it. `set_signer` and `remove_signer` on slot 0 throw `InvalidSlot`.
- `set_master_weight(0)` after a second signer carries the high threshold deregisters slot 0 while
  `master_key` still returns the creation key; `set_master_weight(0)` as the only signer throws
  `WouldLockOut`.
- A change that drops `sum(weights)` below any of low, medium, or high throws `WouldLockOut` with
  nothing written (threshold raises, `remove_signer`, and a signer weight decrease are each
  covered); a zero threshold likewise.
- Calling the account from another mock contract, with a strong claim on that contract, throws
  `NotRootInvocation`.
- Factory: `address_of` equals the deployed address; an unfunded predicted address throws
  `InsufficientFunding`; a second `initialize` on the account throws `AlreadyInitialized`; the
  account's `create_account` operation funds and creates a second account in one frame.
- `master_key` round-trips the key given to the factory; a `dev`-only test formats it with
  `groundhog_signing::format_public_key` to show the literal `G...` string.
- `invoke` passes a call to a mock target and returns its bytes; a child abort surfaces as the
  child's exception.

The chain side is observed natively too: `tests/support/mod.rs::chain_accepts` builds and really
signs a transaction to the account and asks the native executor's own verifier
(`TestEnvironmentHandle::verify_signed_transaction_auth`) whether it would be admitted against the
registration and required weight the executor stores for the account, not the contract's mirror.
Those tests show that a claim of 2 needs both signers once high is 2, that `set_master_weight(0)`
then `set_master_weight(4)` re-registers the creation key at slot 0 with weight 4, that a refused
`WouldLockOut` change leaves the registration and the required weight as they were, and that the
chain enforces `low` even when the claim asks for less (`max(stored, claimed)`).

**Live, `contracts/stellar-account/tests/testkit_account.rs`, `#[ignore]`.** Against a devnode via
`groundhog-testkit`: register the account code, deploy and configure the factory, fund the predicted
address, and create an account for a test-only master key. Then, with hand-built transactions whose
invoked address is the account (the test assembles the signature list itself; the signing crate's
helper emits one signature): add a second signer at weight 1 and raise high to 2 with the master
alone; show a high-threshold change signed by the master alone and claiming 2 is refused at
admission, and one claiming only 1 is admitted but refused by the account; land the same change
signed by both keys; then make a payment signed by the second signer alone. This exercises the
real node end to end, where the native tests above exercise the same verifier in-process.

**Open risk (resolved).** The native mock executor honors both `ChangePublicKeyRegistration` and
`WriteAddressRequiredWeight`, so every rule has native coverage. The raw entrypoints used by the
native tests are reached through a `dev`-gated re-export (`stellar_account::stellar_account_exports`),
because the contract macro emits its exports module privately. The ERC20 `transfer` selector in
tests is computed with `sdk::hash_to_array!("ERC20::0.1::transfer")` because the macro generates
no entrypoints enum for trait impls. The live devnode test exists but has not been executed on
this machine (no devnode binary available).

## Documentation

- `contracts/stellar-account/README.md` in the style of the speedex README: the mapping table from
  Stellar concepts (master key, signers, thresholds, starting balance, `set_options`) to this
  contract, the threshold-via-claim mechanism, and the client's job of choosing a slot by reading
  `AddressAuthData` over RPC.
- A row each for the account and factory in the top-level README examples table.
- An explicit "what is not Stellar here" list: no sequence numbers (the uniquifier covers replay),
  no trustlines or non-native assets beyond ERC20 addresses, no data entries, flags, home domain,
  sponsorship, pre-auth or hash-x signers, and no Stellar XDR envelope parsing.

## Out of scope

Accepting Stellar-signed transaction envelopes; a low-threshold operation; a lockout guard that
reasons about which specific keys exist; CLI or wallet-extension support for multi-signature
assembly beyond what the live test does by hand.
