# Stellar-Classic Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `stellar-account`, `stellar-account-factory`, and `stellar-account-factory-if` to groundhog-examples: a Stellar-classic account model (master key, 20 weighted signers, low/medium/high thresholds, `payment`, `create_account`, signer management) built on Groundhog's native weighted-key authorization.

**Architecture:** The chain verifies signatures and admits a transaction only when the signers' weights reach the claimed `required_weight`. The account contract stores three thresholds plus a mirror of per-slot weights, pins the chain-enforced required weight to the low threshold, and every state-changing entry point requires (1) root invocation and (2) `claim.required_weight >= threshold[category]`. A factory deploys accounts at an address derived from the master key and initializes them in the same frame.

**Tech Stack:** Rust 2024, `sdk` 0.41.1 (`#[contract]`, `#[contract_type]`, `#[derive(Event)]`, `Value` storage, `add_address_public_key` / `remove_address_public_key` / `set_address_required_weight` / `get_auth_claim`), `groundhog-erc20-if` 0.1.42 (`Amount = u128`), native tests on `TestEnvironment` with `env.transaction().with_auth_claim(..)`, an `#[ignore]`d live test on `groundhog-testkit` + `groundhog-signing`.

**Spec:** `docs/superpowers/specs/2026-09-30-stellar-account-design.md`

## Global Constraints

- Every crate: `#![cfg_attr(not(feature = "dev"), no_std)]`, `sdk::declare_mock_contract!()`, `publish.workspace = true`, `edition.workspace = true`, a `dev` feature enabling `sdk/dev` and every dependency's `dev`, and for contract crates an `entrypoints` feature with a `src/main.rs` bin wrapper (`required-features = ["entrypoints"]`).
- Pinned versions come from the workspace: `sdk = { workspace = true }`, `groundhog-erc20-if = { workspace = true }`. Do not add new registry dependencies beyond those already in `[workspace.dependencies]` (`groundhog-xdr`, `groundhog-signing`, `groundhog-testkit`, `groundhog-json-rpc-client`, `groundhog-json-rpc-types`, `groundhog-domain-separator`, `ed25519-dalek`, `thiserror`, `tokio`, `serde_json`, `hex`).
- Slot count is 21 (`kMaxSigners`); slot 0 is the master key and is never re-keyed. Thresholds and the chain-enforced required weight are never below 1.
- Error enums are `#[contract_exception] #[non_exhaustive]` with `#[cfg_attr(feature = "dev", derive(thiserror::Error))]` and explicit discriminants starting at 1.
- Run tests with `cargo test -p <crate>` (not `groundhog test`; see memory on FFI credential shadowing).
- Git: the repo hooks only allow commits on `geoff/*` branches and reject `Co-Authored-By: Claude` / "Generated with Claude Code" trailers. Work on `geoff/stellar-account-design` (already checked out). Commit messages are plain one-liners.
- Shell: zsh. Never start a word with `=` in a shell command (zsh expands it); use `grep -F` or quotes for `--include=*.rs` patterns.

## Review Focus

1. `set_signer` / `remove_signer` with `slot >= 21` or `slot == 0` must throw `InvalidSlot`, never reach the syscall. Pinned in Task 4.
2. `remove_signer` on an empty slot (mirror weight 0) must throw `InvalidSlot` rather than issue a no-op deregistration whose chain semantics are unspecified. Pinned in Task 4.
3. A `kPubkeySignature` claim (a bare pubkey account calling in) must be refused with `InsufficientAuthWeight`, since it carries no weight. Pinned in Task 3.
4. `invoke` whose target is the account itself (reentrance) must surface as `CallFaulted`, not a hang or silent success. Pinned in Task 5.
5. `set_master_weight(0)` followed by `set_master_weight(n)` must re-register the stored creation key, and `master_key()` must be unchanged throughout. Pinned in Task 4.

---

## File Structure

| Path | Responsibility |
|---|---|
| `interfaces/stellar-account-factory-if/Cargo.toml`, `src/lib.rs` | `FactoryConfig`, `AccountFactoryError`, `AccountInitError`, `AccountCreated` event, `StellarAccountFactory` trait + client, `StellarAccountInitializer` trait + client, `deployment_nonce`, `account_address`. |
| `contracts/stellar-account/Cargo.toml`, `src/main.rs` | Crate plumbing and rv32 bin wrapper. |
| `contracts/stellar-account/src/lib.rs` | Public types: `MAX_SIGNERS`, `Thresholds`, `AccountConfig`, `AccountError`, `SignerChanged`, `ThresholdsChanged`; re-exports. |
| `contracts/stellar-account/src/account.rs` | The contract: storage, auth preamble, lockout guard, all entry points, initializer impl. |
| `contracts/stellar-account/tests/support/mod.rs` | Addresses, keys, claims, the root-frame runner, setup. |
| `contracts/stellar-account/tests/account.rs` | Native tests for thresholds, signers, payment, invoke, create_account. |
| `contracts/stellar-account/tests/testkit_account.rs` | `#[ignore]`d live devnode test with a hand-built two-signature transaction. |
| `contracts/stellar-account/README.md` | Stellar-to-Groundhog mapping and what is not Stellar. |
| `contracts/stellar-account-factory/Cargo.toml`, `src/lib.rs`, `src/main.rs` | Factory contract. |
| `contracts/stellar-account-factory/tests/factory.rs` | Native tests for creation, derivation, funding, G strkey round trip. |
| `README.md` | Two new rows in the examples table, three in the validity table. |

---

### Task 1: Factory interface crate

**Files:**
- Create: `interfaces/stellar-account-factory-if/Cargo.toml`
- Create: `interfaces/stellar-account-factory-if/src/lib.rs`

**Interfaces:**
- Produces (used by Tasks 2 to 8):
  - `pub struct FactoryConfig { pub account_code_hash: SHA256Hash, pub native_token: ContractAddress, pub required_funding: u128 }`
  - `pub enum AccountFactoryError { AlreadyInitialized = 1, InvalidConfig = 2, InsufficientFunding = 3, AddressMismatch = 4 }`
  - `pub enum AccountInitError { AlreadyInitialized = 1 }`
  - `pub struct AccountCreated { #[topic] pub account: ContractAddress, pub master_key: Ed25519PublicKey }`
  - `trait StellarAccountFactory { fn initialize(&mut self, config: FactoryConfig); fn create_account(&mut self, master_key: &Ed25519PublicKey) -> ContractAddress; fn address_of(&self, master_key: &Ed25519PublicKey) -> ContractAddress; fn config(&self) -> FactoryConfig; }` with client `StellarAccountFactoryClient`
  - `trait StellarAccountInitializer { fn initialize(&mut self, master_key: &Ed25519PublicKey); }` with client `StellarAccountInitializerClient`
  - `pub fn deployment_nonce(master_key: &Ed25519PublicKey) -> SHA256Hash`
  - `pub fn account_address(factory: &ContractAddress, account_code_hash: &SHA256Hash, master_key: &Ed25519PublicKey) -> ContractAddress`

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "stellar-account-factory-if"
description = "Shared interfaces and address derivation for the Stellar-classic account factory"
version = "0.1.0"
edition.workspace = true
authors.workspace = true
license.workspace = true
publish.workspace = true
repository.workspace = true
homepage.workspace = true
keywords.workspace = true
categories.workspace = true

[lib]
doctest = false

[dependencies]
sdk = { workspace = true }
thiserror = { workspace = true, optional = true }

[dev-dependencies]
stellar-account-factory-if = { path = ".", features = ["dev"] }

[features]
dev = ["sdk/dev", "dep:thiserror"]
```

- [ ] **Step 2: Write `src/lib.rs`**

```rust
//! Shared interfaces and deterministic derivation for Stellar-classic accounts.
//!
//! ABI definitions only: the account and its factory implement these traits
//! without depending on each other. A Stellar `G...` key maps to exactly one
//! account address per factory, computed by [`account_address`].

#![cfg_attr(not(feature = "dev"), no_std)]

pub use sdk::{ContractAddress, Ed25519PublicKey, SHA256Hash};
use sdk::*;

/// Immutable configuration for one account factory deployment.
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct FactoryConfig {
    /// Hash of the only account artifact this factory may deploy.
    pub account_code_hash: SHA256Hash,
    /// Native HOG contract used to check a new account's starting balance.
    pub native_token: ContractAddress,
    /// Native HOG an account address must hold before it can be created:
    /// Stellar's starting balance, and where hogd's deployment storage charge
    /// lands.
    pub required_funding: u128,
}

/// Why the factory refused.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountFactoryError {
    #[cfg_attr(feature = "dev", error("Factory already initialized"))]
    AlreadyInitialized = 1,
    #[cfg_attr(feature = "dev", error("Invalid factory configuration"))]
    InvalidConfig = 2,
    #[cfg_attr(feature = "dev", error("Predicted account address lacks the required funding"))]
    InsufficientFunding = 3,
    #[cfg_attr(feature = "dev", error("Deployed address differs from the prediction"))]
    AddressMismatch = 4,
}

/// Why an account refused to initialize.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountInitError {
    #[cfg_attr(feature = "dev", error("Account already initialized"))]
    AlreadyInitialized = 1,
}

/// Emitted once per created account: the address and the master key it answers to.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct AccountCreated {
    #[topic]
    pub account: ContractAddress,
    pub master_key: Ed25519PublicKey,
}

/// Deterministic deployment of Stellar-classic accounts.
#[contract(
    client = StellarAccountFactoryClient,
    throws = AccountFactoryError,
    emits(AccountCreated)
)]
pub trait StellarAccountFactory {
    /// Writes the immutable configuration exactly once.
    fn initialize(&mut self, config: FactoryConfig);

    /// Deploys and initializes the account for `master_key` at
    /// [`address_of`](Self::address_of). The predicted address must already
    /// hold `required_funding` of the native token.
    fn create_account(&mut self, master_key: &Ed25519PublicKey) -> ContractAddress;

    /// The address `create_account(master_key)` deploys to.
    fn address_of(&self, master_key: &Ed25519PublicKey) -> ContractAddress;

    /// The immutable configuration.
    fn config(&self) -> FactoryConfig;
}

/// The one-shot initializer the factory calls in its own frame.
#[contract(client = StellarAccountInitializerClient, throws = AccountInitError)]
pub trait StellarAccountInitializer {
    /// Register `master_key` at slot 0 with weight 1, set every threshold to 1.
    fn initialize(&mut self, master_key: &Ed25519PublicKey);
}

const DEPLOYMENT_DOMAIN: &str = "groundhog-stellar-account-factory-v1";

/// The deployment nonce for `master_key`: a domain-tagged hash, so the same
/// key under a different factory version lands elsewhere.
pub fn deployment_nonce(master_key: &Ed25519PublicKey) -> SHA256Hash {
    (DEPLOYMENT_DOMAIN, master_key).hash()
}

/// The account address for `master_key` as if `factory` performed the
/// deployment. Needs a contract or SDK test context: address derivation is a
/// host syscall.
pub fn account_address(
    factory: &ContractAddress,
    account_code_hash: &SHA256Hash,
    master_key: &Ed25519PublicKey,
) -> ContractAddress {
    get_deploy_address_for_other(factory, &deployment_nonce(master_key), account_code_hash)
}
```

- [ ] **Step 3: Build**

Run: `cargo build -p stellar-account-factory-if && cargo build -p stellar-account-factory-if --features dev`
Expected: both succeed. If `(DEPLOYMENT_DOMAIN, master_key).hash()` fails to compile because `Ed25519PublicKey` lacks `WriteXDR` in the tuple, replace with `(DEPLOYMENT_DOMAIN, master_key.as_ref()).hash()` where `as_ref()` yields `&[u8]`.

- [ ] **Step 4: Commit**

```bash
git add interfaces/stellar-account-factory-if
git commit -m "feat(stellar-account-factory-if): factory and initializer interfaces with address derivation"
```

---

### Task 2: Account crate skeleton, initialize, and views (probes the registration syscall in the mock)

**Files:**
- Create: `contracts/stellar-account/Cargo.toml`
- Create: `contracts/stellar-account/src/main.rs`
- Create: `contracts/stellar-account/src/lib.rs`
- Create: `contracts/stellar-account/src/account.rs`
- Create: `contracts/stellar-account/tests/support/mod.rs`
- Create: `contracts/stellar-account/tests/account.rs`

**Interfaces:**
- Consumes: `StellarAccountInitializer`, `AccountInitError` from Task 1.
- Produces:
  - `pub const MAX_SIGNERS: usize = 21;`
  - `pub struct Thresholds { pub low: u32, pub medium: u32, pub high: u32 }`
  - `pub struct AccountConfig { pub master_key: Ed25519PublicKey, pub thresholds: Thresholds, pub weights: [u32; MAX_SIGNERS] }`
  - `pub enum AccountError { NotRootInvocation = 1, InsufficientAuthWeight = 2, InvalidSlot = 3, ZeroWeight = 4, WouldLockOut = 5, CallFaulted = 6 }`
  - storage struct `StellarAccount`, client `StellarAccountClient`, exports modules `stellar_account_exports` (inherent impl) and `stellar_account_init_exports` (initializer impl), each with `pub fn <method>_internal()` raw entrypoints.
  - Views: `master_key() -> Ed25519PublicKey`, `thresholds() -> Thresholds`, `signer_weights() -> [u32; MAX_SIGNERS]`.
  - Test support: `ROOT`, `ACCOUNT`, `TOKEN`, `RECEIVER`, `master_key()`, `second_key()`, `claim(weight)`, `pubkey_claim()`, `as_account(env, claim, args, entry)`, `setup()`, `setup_with_hash() -> (env, account_hash)`, `balance_of(env, who)`, `assert_account_error(result, expected)`.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "stellar-account"
description = "A Stellar-classic account: master key, weighted signers, and operation thresholds on Groundhog's native auth"
version = "0.1.0"
authors.workspace = true
license.workspace = true
publish.workspace = true
repository.workspace = true
homepage.workspace = true
keywords.workspace = true
categories.workspace = true
edition.workspace = true

[features]
entrypoints = []
dev = [
    "sdk/dev",
    "dep:thiserror",
    "groundhog-erc20-if/dev",
    "stellar-account-factory-if/dev",
]

[lib]
crate-type = ["rlib"]
doctest = false
test = false

[[bin]]
name = "stellar_account"
path = "src/main.rs"
required-features = ["entrypoints"]
test = false
bench = false

[dependencies]
# `alloc`: `invoke` returns the child's bytes as a `BytesM`.
sdk = { workspace = true, features = ["alloc"] }
groundhog-erc20-if = { workspace = true }
stellar-account-factory-if = { path = "../../interfaces/stellar-account-factory-if", version = "=0.1.0" }
thiserror = { workspace = true, optional = true }

[dev-dependencies]
stellar-account = { path = ".", features = ["dev"] }
erc20 = { path = "../erc20", features = ["dev"] }
stellar-account-factory = { path = "../stellar-account-factory", features = ["dev"] }
groundhog-xdr = { workspace = true }
ed25519-dalek = { workspace = true }
groundhog-signing = { workspace = true }
# The live flow on a devnode (`tests/testkit_account.rs`, `#[ignore]`d).
groundhog-testkit = { workspace = true }
groundhog-json-rpc-client = { workspace = true }
groundhog-json-rpc-types = { workspace = true }
groundhog-domain-separator = { workspace = true, features = ["std"] }
serde_json = { workspace = true }
hex = { workspace = true }
tokio = { workspace = true }

[lints]
clippy.result_large_err = "allow"
```

The `stellar-account-factory` dev-dependency does not exist until Task 6. Until then, comment that line out; Task 6 uncomments it.

- [ ] **Step 2: Write `src/main.rs`**

```rust
//! RV32 binary wrapper for the `stellar-account` contract library.
//!
//! `groundhog build` builds this bin with the `entrypoints` feature so the
//! `#[contract]` macro emits rv32 method entry symbols. Referencing the
//! library links the macro-emitted symbols in; the runtime arrives
//! transitively through `sdk`'s rv32 runtime dependency.

#![no_std]
#![no_main]

extern crate stellar_account;
```

- [ ] **Step 3: Write `src/lib.rs`**

```rust
//! A Stellar-classic account on Groundhog.
//!
//! Stellar classic authorizes an operation when the weights of the keys that
//! signed it reach the account's threshold for that operation's category:
//! low, medium, or high. Groundhog's protocol has the same shape at the
//! address level: every address carries up to 21 weighted keys and one
//! required weight, and hogd admits a transaction only when its signers'
//! weights reach the larger of that stored weight and the weight the
//! transaction's auth claim asks for.
//!
//! This contract keeps Stellar's three thresholds and pins the chain-enforced
//! required weight to the low one. Each entry point then checks that the
//! transaction's claimed weight reaches its category's threshold, which, given
//! what hogd already verified, is Stellar's threshold check with no signature
//! handling here at all. Signers other than the master live only in the
//! chain's registration; the account mirrors their weights (there is no
//! syscall to read them back) so it can refuse a change that would lock it
//! out.
//!
//! The master key is the account's identity, as in Stellar: it is fixed at
//! creation, only its weight changes, and [`master_key`](StellarAccount::master_key)
//! reports it so the `G...` strkey is recoverable from the account.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

sdk::declare_mock_contract!();

use sdk::*;

mod account;

pub use account::StellarAccount;
pub use stellar_account_factory_if::{
    AccountCreated, AccountFactoryError, AccountInitError, FactoryConfig,
    StellarAccountFactoryClient, StellarAccountInitializer, StellarAccountInitializerClient,
};

/// Key slots per address: Stellar's 20 signers plus the master key at slot 0.
pub const MAX_SIGNERS: usize = 21;

/// Stellar's operation thresholds. Every value stays at or above 1.
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Thresholds {
    /// Stored for fidelity; no shipped operation uses it. Also the
    /// chain-enforced required weight.
    pub low: u32,
    /// `payment`, `create_account`, `invoke`.
    pub medium: u32,
    /// `set_signer`, `remove_signer`, `set_master_weight`, `set_thresholds`.
    pub high: u32,
}

/// Everything the account stores.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountConfig {
    /// Immutable after `initialize`.
    pub master_key: Ed25519PublicKey,
    pub thresholds: Thresholds,
    /// Mirror of each slot's registered weight; 0 means the slot is empty.
    pub weights: [u32; MAX_SIGNERS],
}

/// Why the account refused.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountError {
    /// Called from another contract's frame. The auth claim is verified
    /// against the invoked address, so only a root invocation says anything
    /// about this account's signers.
    #[cfg_attr(feature = "dev", error("Account operations must be the root invocation"))]
    NotRootInvocation = 1,
    /// The claimed required weight is below this operation's threshold, or
    /// the claim is not a source-address claim.
    #[cfg_attr(feature = "dev", error("Claimed weight is below the operation's threshold"))]
    InsufficientAuthWeight = 2,
    /// Slot 0, a slot at or past 21, or removing an empty slot.
    #[cfg_attr(feature = "dev", error("Invalid signer slot"))]
    InvalidSlot = 3,
    /// `set_signer` with weight 0; use `remove_signer`.
    #[cfg_attr(feature = "dev", error("Signer weight must be at least 1"))]
    ZeroWeight = 4,
    /// The change would leave total weight below the high threshold, or a
    /// threshold below 1.
    #[cfg_attr(feature = "dev", error("Change would lock the account out"))]
    WouldLockOut = 5,
    /// `invoke`'s target faulted or the call was rejected before running.
    #[cfg_attr(feature = "dev", error("Invoked call faulted"))]
    CallFaulted = 6,
}

/// A slot's registration changed; `weight` 0 means it was removed.
#[derive(Event)]
pub struct SignerChanged {
    #[topic]
    pub slot: u32,
    pub weight: u32,
}

#[derive(Event)]
pub struct ThresholdsChanged {
    pub low: u32,
    pub medium: u32,
    pub high: u32,
}
```

- [ ] **Step 4: Write `src/account.rs` with initialize and views only**

```rust
//! The account contract: storage, authorization preamble, entry points.

use sdk::storage::Value;
use sdk::sys::{self, SyscallErrorCode, SyscallNo};
use sdk::*;
use stellar_account_factory_if::{AccountInitError, StellarAccountInitializer};

use crate::{AccountConfig, AccountError, MAX_SIGNERS, SignerChanged, Thresholds, ThresholdsChanged};

#[sdk::storage]
pub struct StellarAccount {
    config: Value<AccountConfig>,
}

impl StellarAccount {
    /// Register `key` at `slot` with `weight` on this address.
    fn register(slot: u32, key: &Ed25519PublicKey, weight: u32) {
        add_address_public_key(slot, PublicKey::Ed25519 { ed25519: *key }, weight)
            .or_syscall_throw(SyscallNo::kChangePublicKeyRegistration);
    }

    /// Deregister `slot` on this address.
    fn deregister(slot: u32) {
        remove_address_public_key(slot).or_syscall_throw(SyscallNo::kChangePublicKeyRegistration);
    }

    /// Pin the chain-enforced required weight to the low threshold.
    fn write_chain_threshold(low: u32) {
        set_address_required_weight(low).or_syscall_throw(SyscallNo::kWriteAddressRequiredWeight);
    }
}

#[contract(exports = "stellar_account_init_exports")]
impl StellarAccountInitializer for StellarAccount {
    fn initialize(&mut self, master_key: &Ed25519PublicKey) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(AccountInitError::AlreadyInitialized);
        }
        let mut weights = [0u32; MAX_SIGNERS];
        weights[0] = 1;
        Self::register(0, master_key, 1);
        Self::write_chain_threshold(1);
        self.config.set(&AccountConfig {
            master_key: *master_key,
            thresholds: Thresholds { low: 1, medium: 1, high: 1 },
            weights,
        });
    }
}

#[contract(
    throws = AccountError,
    emits(SignerChanged, ThresholdsChanged),
    exports = "stellar_account_exports"
)]
impl StellarAccount {
    /// The creation key, whether or not slot 0 is currently registered.
    pub fn master_key(&self) -> Ed25519PublicKey {
        self.config.get().master_key
    }

    pub fn thresholds(&self) -> Thresholds {
        self.config.get().thresholds
    }

    /// The weight registered at each slot; 0 is empty.
    pub fn signer_weights(&self) -> [u32; MAX_SIGNERS] {
        self.config.get().weights
    }
}
```

If the compiler reports that `Ed25519PublicKey` is not `Copy`, replace `*master_key` with `master_key.clone()` and add `.clone()` where the key is moved. If `SyscallNo::kChangePublicKeyRegistration` does not exist, inspect the generated names with `grep -rho 'kChangePublicKey[A-Za-z]*' target/debug/build/groundhog-xdr-*/out | sort -u` after a build and use what it prints.

- [ ] **Step 5: Write `tests/support/mod.rs`**

```rust
//! Shared fixture for the account tests.
//!
//! Every state-changing account entry point requires the root invocation, so
//! these tests cannot drive the account through a client from another
//! address. Instead `as_account` opens the account's own frame as the root,
//! sets the calldata the entry point will decode, attaches the auth claim the
//! test wants observed, and runs the generated raw entrypoint. The mock does
//! not verify signatures, so the claim's `required_weight` is the whole input
//! to the threshold check.
#![allow(dead_code)]

use ed25519_dalek::SigningKey;
use groundhog_xdr::auth_claim::AuthClaim_source_address_claim;
use sdk::call::RawCallError;
use sdk::*;
use stellar_account::AccountError;
use stellar_account_factory_if::StellarAccountInitializerClient;

pub const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
pub const ACCOUNT: ContractAddress = ContractAddress::new([0x20; 32]);
pub const TOKEN: ContractAddress = ContractAddress::new([0x30; 32]);
pub const RECEIVER: ContractAddress = ContractAddress::new([0x40; 32]);

const MASTER_SEED: [u8; 32] = [0x11; 32];
const SECOND_SEED: [u8; 32] = [0x22; 32];

pub const MINTED: u128 = 1_000;

pub fn key_from(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}
pub fn master_key() -> Ed25519PublicKey {
    key_from(&MASTER_SEED)
}
pub fn second_key() -> Ed25519PublicKey {
    key_from(&SECOND_SEED)
}

/// A source-address claim asking for `weight`. Any registered signer is
/// allowed; the account ignores the bitmap, as Stellar does.
pub fn claim(weight: u32) -> AuthClaim {
    AuthClaim::kSourceAddressAuthData {
        source_address_claim: AuthClaim_source_address_claim {
            allowed_keys: 0xFFFF_FFFF,
            required_weight: weight,
        },
    }
}

/// The claim a bare pubkey account carries. It names no weight.
pub fn pubkey_claim() -> AuthClaim {
    AuthClaim::kPubkeySignature {
        pubkey_preimage: PubkeyAccountPreimage {
            pubkey: PublicKey::Ed25519 { ed25519: master_key() },
            nonce: 0,
        },
    }
}

/// Run `entry` as the account's root invocation with `claim` attached and
/// `args` as the calldata it decodes. `entry` is one of the
/// `stellar_account_exports::*_internal` raw entrypoints.
pub fn as_account<A: WriteXDR>(
    env: &TestEnvironmentHandle,
    claim: AuthClaim,
    args: &A,
    entry: fn(),
) -> TransactResult {
    let calldata = BytesM(sdk::xdr::cxs::encode(args).expect("encoding calldata"));
    env.transaction()
        .with_auth_claim(claim)
        .transact(|tx| tx.call(&ACCOUNT).with_calldata(calldata).run(entry))
}

/// The account refused the root invocation with `expected`.
pub fn assert_account_error(result: &TransactResult, expected: AccountError) {
    result.assert_abort();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<AccountError>(), Some(expected));
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

/// Account deployed and initialized for `master_key()`, an ERC20 at `TOKEN`
/// with `MINTED` units at the account, all committed and visible.
pub fn setup() -> TestEnvironmentHandle {
    setup_with_hash().0
}

/// [`setup`], also returning the account code hash so a factory can be
/// configured to deploy more accounts of the same code. The mock package is
/// registered exactly once here.
pub fn setup_with_hash() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let account = stellar_account::register_mock_contract(&env);
    let account_hash = *account.as_hash();
    account.deploy_contract_to(&ACCOUNT);
    erc20::register_mock_contract(&env).deploy_contract_to(&TOKEN);

    // Initialization is open to any caller and has no root requirement, so a
    // child-frame client call from ROOT is fine here.
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StellarAccountInitializerClient::new(&ACCOUNT).initialize(&master_key());
            let token = erc20::ERC20Client::new(&TOKEN);
            token.initialize(&ROOT);
            token.mint(&ACCOUNT, MINTED);
        })
    })
    .assert_success();
    env.advance_block();
    (env, account_hash)
}

pub fn balance_of(env: &TestEnvironmentHandle, who: ContractAddress) -> u128 {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || erc20::ERC20Client::new(&TOKEN).get_balance_of(&who))
    });
    result.assert_success();
    result.assert_return_as::<u128>()
}
```

If `with_calldata` rejects `sdk::BytesM` because the harness wants `xdr_common::BytesM`, construct it as `xdr_common::BytesM(bytes)` by adding `xdr-common` to dev-dependencies only if it is already a transitive dependency with a workspace entry; otherwise wrap via `.into()` if a `From` exists. Report what worked.

- [ ] **Step 6: Write the first tests in `tests/account.rs`**

```rust
mod support;

use sdk::*;
use stellar_account::{AccountInitError, MAX_SIGNERS, StellarAccountClient, Thresholds};
use stellar_account_factory_if::StellarAccountInitializerClient;
use support::*;

#[test]
fn initialize_registers_the_master_key_at_slot_zero_with_every_threshold_at_one() {
    let env = setup();
    let result = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let account = StellarAccountClient::new(&ACCOUNT);
            (account.master_key(), account.thresholds(), account.signer_weights())
        })
    });
    result.assert_success();
    let (key, thresholds, weights): (Ed25519PublicKey, Thresholds, [u32; MAX_SIGNERS]) =
        result.assert_return_as();
    assert_eq!(key, master_key());
    assert_eq!(thresholds, Thresholds { low: 1, medium: 1, high: 1 });
    let mut expected = [0u32; MAX_SIGNERS];
    expected[0] = 1;
    assert_eq!(weights, expected);
}

#[test]
fn initialize_refuses_a_second_call() {
    let env = setup();
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let result =
                StellarAccountInitializerClient::new(&ACCOUNT).try_initialize(&second_key());
            assert_eq!(
                result.unwrap_err().try_as(),
                Some(AccountInitError::AlreadyInitialized)
            );
        })
    })
    .assert_success();
}
```

- [ ] **Step 7: Run the tests**

Run: `cargo test -p stellar-account --test account`
Expected: both pass. This is the probe for the open risk: `initialize` calls `ChangePublicKeyRegistration` and `WriteAddressRequiredWeight` through the mock. If `initialize` faults with a syscall error rather than succeeding, record the exact error in the commit message and in the spec's "Open risk" paragraph, and continue: the remaining tasks still test every rule except these two writes.

- [ ] **Step 8: Commit**

```bash
git add contracts/stellar-account
git commit -m "feat(stellar-account): crate skeleton, initialize, and views"
```

---

### Task 3: Authorization preamble and `payment`

**Files:**
- Modify: `contracts/stellar-account/src/account.rs`
- Modify: `contracts/stellar-account/tests/account.rs`

**Interfaces:**
- Produces: private `enum Category { Medium, High }`, `fn require_root_invocation()`, `fn authorize(&self, Category) -> AccountConfig`; entry point `payment(&self, asset: &ContractAddress, to: &ContractAddress, amount: u128)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/account.rs`:

```rust
#[test]
fn payment_at_the_medium_threshold_moves_tokens() {
    let env = setup();
    as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, 250u128),
        stellar_account::stellar_account_exports::payment_internal,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 250);
    assert_eq!(balance_of(&env, ACCOUNT), MINTED - 250);
}

#[test]
fn payment_below_the_medium_threshold_is_refused() {
    let env = setup();
    raise_thresholds(&env, 1, 2, 2);
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, 250u128),
        stellar_account::stellar_account_exports::payment_internal,
    );
    assert_account_error(&result, AccountError::InsufficientAuthWeight);
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 0);
}

#[test]
fn a_pubkey_claim_carries_no_weight() {
    let env = setup();
    let result = as_account(
        &env,
        pubkey_claim(),
        &(TOKEN, RECEIVER, 1u128),
        stellar_account::stellar_account_exports::payment_internal,
    );
    assert_account_error(&result, AccountError::InsufficientAuthWeight);
}

#[test]
fn a_call_from_another_contract_is_not_the_root_invocation() {
    let env = setup();
    // A strong claim, but on ROOT's transaction, not the account's.
    env.transaction()
        .with_auth_claim(claim(100))
        .transact(|tx| {
            tx.call(&ROOT).run(|| {
                let result = StellarAccountClient::new(&ACCOUNT).try_payment(&TOKEN, &RECEIVER, 1);
                assert_eq!(
                    result.unwrap_err().try_as(),
                    Some(AccountError::NotRootInvocation)
                );
            })
        })
        .assert_success();
}

#[test]
fn payment_beyond_the_balance_surfaces_the_token_error() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, MINTED + 1),
        stellar_account::stellar_account_exports::payment_internal,
    );
    result.assert_abort();
    match into_root_call_result::<()>(&result) {
        Err(sdk::call::RawCallError::Exception(error)) => {
            assert!(error.try_as::<erc20::ERC20Error>().is_some(), "an ERC20 error, got {error:?}");
        }
        other => panic!("expected an ERC20 exception, got {other:?}"),
    }
}
```

Add `use stellar_account::AccountError;` to the imports, and this helper at the bottom of `tests/account.rs` (it uses `set_thresholds`, implemented in Task 4; until then the two tests that call it fail to compile, which is expected, so add `#[ignore = "set_thresholds lands in Task 4"]` to `payment_below_the_medium_threshold_is_refused` and remove it in Task 4):

```rust
/// Raise thresholds as the account at a claimed weight that clears the
/// current high threshold (1 right after setup).
fn raise_thresholds(env: &TestEnvironmentHandle, low: u32, medium: u32, high: u32) {
    as_account(
        env,
        claim(1),
        &(low, medium, high),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    )
    .assert_success();
    env.advance_block();
}
```

For this task only, stub `raise_thresholds` so the file compiles:

```rust
fn raise_thresholds(_env: &TestEnvironmentHandle, _low: u32, _medium: u32, _high: u32) {
    unimplemented!("Task 4")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p stellar-account --test account`
Expected: compile error, `payment_internal` not found.

- [ ] **Step 3: Implement the preamble and `payment`**

In `src/account.rs`, add to the imports `use groundhog_erc20_if::ERC20Client;` and add inside the first (private) `impl StellarAccount`:

```rust
/// Stellar's operation categories. Low is stored but no shipped operation
/// uses it.
#[derive(Clone, Copy)]
enum Category {
    Medium,
    High,
}

impl StellarAccount {
    /// Refuse unless this frame is the transaction's root invocation. A
    /// transaction's auth claim is verified against the invoked address's
    /// registration, so a claim observed from a child frame says nothing
    /// about this account's signers.
    fn require_root_invocation() {
        let mut sender = ContractAddress::from([0u8; 32]);
        match sys::raw_GetMsgSender(&mut sender) {
            Err(e) if e == SyscallErrorCode::kSyscallErrorCodeIsRootTransaction.into() => {}
            _ => throw(AccountError::NotRootInvocation),
        }
    }

    /// Root invocation, then the claimed weight reaches `category`'s
    /// threshold. hogd already required the signers of this transaction to
    /// sum to at least the claimed weight, so this is the complete threshold
    /// check. Returns the config so callers read it once.
    fn authorize(&self, category: Category) -> AccountConfig {
        Self::require_root_invocation();
        let config = self.config.get();
        let threshold = match category {
            Category::Medium => config.thresholds.medium,
            Category::High => config.thresholds.high,
        };
        match get_auth_claim() {
            Ok(AuthClaim::kSourceAddressAuthData { source_address_claim })
                if source_address_claim.required_weight >= threshold => {}
            _ => throw(AccountError::InsufficientAuthWeight),
        }
        config
    }
}
```

Note `Category` is a free enum, placed above the impl. Then in the `#[contract(... exports = "stellar_account_exports")]` block add:

```rust
    /// Stellar's `payment`: an ERC20 transfer from this account. Native HOG
    /// is the ERC20 at `sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN`.
    /// Medium threshold.
    pub fn payment(&self, asset: &ContractAddress, to: &ContractAddress, amount: u128) {
        self.authorize(Category::Medium);
        ERC20Client::new(asset).transfer(to, amount);
    }
```

If `AuthClaim` is not in scope through `sdk::*`, import `sdk::types::AuthClaim`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p stellar-account --test account`
Expected: all pass except the one `#[ignore]`d.

- [ ] **Step 5: Commit**

```bash
git add contracts/stellar-account
git commit -m "feat(stellar-account): root-invocation and claim-weight preamble, payment"
```

---

### Task 4: Signer and threshold management with the lockout guard

**Files:**
- Modify: `contracts/stellar-account/src/account.rs`
- Modify: `contracts/stellar-account/tests/account.rs`

**Interfaces:**
- Produces entry points, all high threshold: `set_signer(&mut self, slot: u32, key: &Ed25519PublicKey, weight: u32)`, `remove_signer(&mut self, slot: u32)`, `set_master_weight(&mut self, weight: u32)`, `set_thresholds(&mut self, low: u32, medium: u32, high: u32)`; private `fn commit(&mut self, config: &AccountConfig)`.

- [ ] **Step 1: Write the failing tests**

Replace the `raise_thresholds` stub with the real helper from Task 3 Step 1, remove the `#[ignore]` from `payment_below_the_medium_threshold_is_refused`, add `use stellar_account::{SignerChanged, ThresholdsChanged};`, and append:

```rust
fn weights(env: &TestEnvironmentHandle) -> [u32; MAX_SIGNERS] {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StellarAccountClient::new(&ACCOUNT).signer_weights())
    });
    result.assert_success();
    result.assert_return_as()
}

fn add_second_signer(env: &TestEnvironmentHandle, weight: u32) -> TransactResult {
    as_account(
        env,
        claim(1),
        &(1u32, second_key(), weight),
        stellar_account::stellar_account_exports::set_signer_internal,
    )
}

#[test]
fn set_signer_needs_the_high_threshold_and_updates_the_mirror_and_event() {
    let env = setup();
    raise_thresholds(&env, 1, 1, 2);
    // Now high is 2 but the master alone weighs 1: a claim of 1 is refused.
    let refused = add_second_signer(&env, 1);
    assert_account_error(&refused, AccountError::InsufficientAuthWeight);

    // Claiming 2 passes the account check. (On chain this would need two
    // signers; the mock does not verify signatures.)
    let result = as_account(
        &env,
        claim(2),
        &(1u32, second_key(), 3u32),
        stellar_account::stellar_account_exports::set_signer_internal,
    );
    result.assert_success();
    result.assert_event_count(1);
    result.assert_event::<SignerChanged>(0, |e| {
        assert_eq!(e.payload().weight, 3);
    });
    env.advance_block();
    let w = weights(&env);
    assert_eq!(w[0], 1);
    assert_eq!(w[1], 3);
}

#[test]
fn set_signer_rejects_slot_zero_out_of_range_slots_and_zero_weight() {
    let env = setup();
    for (slot, weight, expected) in [
        (0u32, 1u32, AccountError::InvalidSlot),
        (MAX_SIGNERS as u32, 1, AccountError::InvalidSlot),
        (1, 0, AccountError::ZeroWeight),
    ] {
        let result = as_account(
            &env,
            claim(1),
            &(slot, second_key(), weight),
            stellar_account::stellar_account_exports::set_signer_internal,
        );
        assert_account_error(&result, expected);
    }
}

#[test]
fn remove_signer_rejects_slot_zero_and_empty_slots() {
    let env = setup();
    for slot in [0u32, 5] {
        let result = as_account(
            &env,
            claim(1),
            &slot,
            stellar_account::stellar_account_exports::remove_signer_internal,
        );
        assert_account_error(&result, AccountError::InvalidSlot);
    }
}

#[test]
fn remove_signer_clears_the_slot_and_emits_weight_zero() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    let result = as_account(
        &env,
        claim(1),
        &1u32,
        stellar_account::stellar_account_exports::remove_signer_internal,
    );
    result.assert_success();
    result.assert_event::<SignerChanged>(0, |e| assert_eq!(e.payload().weight, 0));
    env.advance_block();
    assert_eq!(weights(&env)[1], 0);
}

#[test]
fn set_thresholds_pins_low_as_the_chain_threshold_and_emits() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    let result = as_account(
        &env,
        claim(1),
        &(1u32, 2u32, 3u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    result.assert_success();
    result.assert_event::<ThresholdsChanged>(0, |e| {
        assert_eq!((e.payload().low, e.payload().medium, e.payload().high), (1, 2, 3));
    });
    env.advance_block();
    let t = env.transact(|tx| tx.call(&ROOT).run(|| StellarAccountClient::new(&ACCOUNT).thresholds()));
    t.assert_success();
    assert_eq!(t.assert_return_as::<Thresholds>(), Thresholds { low: 1, medium: 2, high: 3 });
}

#[test]
fn changes_that_would_lock_the_account_out_are_refused_and_write_nothing() {
    let env = setup();
    // Total weight is 1; a high threshold of 2 is unreachable.
    let result = as_account(
        &env,
        claim(1),
        &(1u32, 1u32, 2u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    result.assert_no_events();

    // A zero threshold is never allowed: it would admit an unsigned transaction.
    let result = as_account(
        &env,
        claim(1),
        &(0u32, 1u32, 1u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);

    // Removing the only signer that carries the high threshold.
    let result = as_account(
        &env,
        claim(1),
        &0u32,
        stellar_account::stellar_account_exports::set_master_weight_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    env.advance_block();
    assert_eq!(weights(&env)[0], 1, "nothing was written");
}

#[test]
fn master_weight_zero_disables_slot_zero_but_the_master_key_is_unchanged() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();

    as_account(&env, claim(1), &0u32, stellar_account::stellar_account_exports::set_master_weight_internal)
        .assert_success();
    env.advance_block();
    assert_eq!(weights(&env)[0], 0);
    let key = env.transact(|tx| tx.call(&ROOT).run(|| StellarAccountClient::new(&ACCOUNT).master_key()));
    key.assert_success();
    assert_eq!(key.assert_return_as::<Ed25519PublicKey>(), master_key(), "identity is fixed");

    // Re-enabling re-registers the stored creation key with the new weight.
    as_account(&env, claim(1), &4u32, stellar_account::stellar_account_exports::set_master_weight_internal)
        .assert_success();
    env.advance_block();
    assert_eq!(weights(&env)[0], 4);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p stellar-account --test account`
Expected: compile error, `set_signer_internal` and friends not found.

- [ ] **Step 3: Implement**

In the private `impl StellarAccount` add:

```rust
    /// The lockout guard, then the write. The sum of the mirrored weights
    /// must reach the high threshold and no threshold may be below 1 (the
    /// chain-enforced weight is the low one, so this also keeps an unsigned
    /// transaction from ever clearing it). On refusal the frame reverts,
    /// including any registration syscall already issued.
    fn commit(&mut self, config: &AccountConfig) {
        let total: u64 = config.weights.iter().map(|w| u64::from(*w)).sum();
        let t = config.thresholds;
        ensure(
            t.low >= 1 && t.medium >= 1 && t.high >= 1 && total >= u64::from(t.high),
            AccountError::WouldLockOut,
        );
        self.config.set(config);
    }

    /// A slot other than the master's, inside the table.
    fn check_signer_slot(slot: u32) {
        ensure(slot >= 1 && (slot as usize) < MAX_SIGNERS, AccountError::InvalidSlot);
    }
```

In the `stellar_account_exports` block add:

```rust
    /// Stellar `set_options` adding or replacing a signer. Slot 0 is the
    /// master key and cannot be re-keyed. High threshold.
    pub fn set_signer(&mut self, slot: u32, key: &Ed25519PublicKey, weight: u32) {
        let mut config = self.authorize(Category::High);
        Self::check_signer_slot(slot);
        ensure(weight >= 1, AccountError::ZeroWeight);
        Self::register(slot, key, weight);
        config.weights[slot as usize] = weight;
        self.commit(&config);
        log_event(&SignerChanged { slot, weight });
    }

    /// Stellar `set_options` removing a signer (weight 0). High threshold.
    pub fn remove_signer(&mut self, slot: u32) {
        let mut config = self.authorize(Category::High);
        Self::check_signer_slot(slot);
        ensure(config.weights[slot as usize] != 0, AccountError::InvalidSlot);
        Self::deregister(slot);
        config.weights[slot as usize] = 0;
        self.commit(&config);
        log_event(&SignerChanged { slot, weight: 0 });
    }

    /// Stellar's master weight. 0 deregisters slot 0; any other value
    /// registers the stored master key with that weight. High threshold.
    pub fn set_master_weight(&mut self, weight: u32) {
        let mut config = self.authorize(Category::High);
        if weight == 0 {
            Self::deregister(0);
        } else {
            Self::register(0, &config.master_key, weight);
        }
        config.weights[0] = weight;
        self.commit(&config);
        log_event(&SignerChanged { slot: 0, weight });
    }

    /// Stellar `set_options` thresholds. `low` becomes the chain-enforced
    /// required weight. High threshold.
    pub fn set_thresholds(&mut self, low: u32, medium: u32, high: u32) {
        let mut config = self.authorize(Category::High);
        config.thresholds = Thresholds { low, medium, high };
        Self::write_chain_threshold(low);
        self.commit(&config);
        log_event(&ThresholdsChanged { low, medium, high });
    }
```

Note `set_master_weight(0)` when slot 0 is already empty issues a deregistration of an empty slot; the lockout guard makes that reachable only when another signer carries the high threshold, and the mirror already reads 0, so the outcome is idempotent. Leave it.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p stellar-account --test account`
Expected: all pass. If `remove_address_public_key(0)` on the mock errors after the key was registered in an earlier block, record the error; the test `master_weight_zero_disables_slot_zero_but_the_master_key_is_unchanged` is the one that exercises it.

- [ ] **Step 5: Commit**

```bash
git add contracts/stellar-account
git commit -m "feat(stellar-account): signer, master-weight, and threshold management with lockout guard"
```

---

### Task 5: `invoke` passthrough

**Files:**
- Modify: `contracts/stellar-account/src/account.rs`
- Modify: `contracts/stellar-account/tests/account.rs`

**Interfaces:**
- Produces: `invoke(&self, target: &ContractAddress, entrypoint: ContractEntrypointID, gas_limit: u64, calldata: &[u8]) -> BytesM`, medium threshold.

- [ ] **Step 1: Write the failing tests**

Append to `tests/account.rs`:

```rust
/// The ERC20 `transfer` selector, derived the way the SDK does for clients:
/// read it off the generated client's call rather than hard-coding bytes.
fn erc20_transfer_entrypoint() -> ContractEntrypointID {
    erc20::ERC20Entrypoints::transfer.into()
}

#[test]
fn invoke_forwards_opaque_calldata_and_returns_the_child_bytes() {
    let env = setup();
    let calldata = sdk::xdr::cxs::encode(&(RECEIVER, 100u128)).unwrap();
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, erc20_transfer_entrypoint(), u64::MAX, calldata.as_slice()),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    result.assert_success();
    assert!(result.assert_return_as::<BytesM>().is_empty(), "transfer returns unit");
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 100);
}

#[test]
fn invoke_re_raises_the_child_abort_verbatim() {
    let env = setup();
    let calldata = sdk::xdr::cxs::encode(&(RECEIVER, MINTED + 1)).unwrap();
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, erc20_transfer_entrypoint(), u64::MAX, calldata.as_slice()),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    result.assert_abort();
    match into_root_call_result::<BytesM>(&result) {
        Err(sdk::call::RawCallError::Exception(error)) => {
            assert!(error.try_as::<erc20::ERC20Error>().is_some(), "the token's own error, got {error:?}");
        }
        other => panic!("expected the child's exception, got {other:?}"),
    }
}

#[test]
fn invoke_into_itself_is_a_fault_not_a_hang() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(ACCOUNT, erc20_transfer_entrypoint(), u64::MAX, &[][..]),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    assert_account_error(&result, AccountError::CallFaulted);
}
```

If `erc20::ERC20Entrypoints` does not exist under that name, find the generated entrypoints enum with `grep -rn "Entrypoints" target/debug/build/erc20-*/ 2>/dev/null` or read the macro output via `cargo expand -p erc20 --features dev | grep -n Entrypoints`; the macro names it `<InterfaceName>Entrypoints` for inherent impls. For a trait impl (the erc20 implements the `ERC20` trait), no wrapper is generated; in that case derive the selector in the test with `sdk::ContractEntrypointID::from(<bytes>)` where the bytes come from `grep -A2 '"transfer"' target/groundhog/*/erc20.spec.json` after `groundhog build -p erc20`, or hard-code the 8 bytes with a comment naming the source. Prefer the generated enum.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p stellar-account --test account`
Expected: compile error, `invoke_internal` not found.

- [ ] **Step 3: Implement**

Add to `src/account.rs` imports: `use sdk::call::{CallOutcome, ReturnBuf, contract_call};` and `use alloc::vec::Vec;` is not needed if `BytesM(return_buf.as_ref().to_vec())` compiles with `alloc` enabled (`to_vec` is in `alloc::slice`, available through the prelude under `extern crate alloc`). Then in the exports block:

```rust
    /// Raw passthrough: call `entrypoint` on `target` with `calldata` as this
    /// account, returning the child's bytes. A child abort is re-raised with
    /// its own payload; a fault or a call rejected before running throws
    /// [`AccountError::CallFaulted`]. No auth tokens are forwarded. Medium
    /// threshold.
    pub fn invoke(
        &self,
        target: &ContractAddress,
        entrypoint: ContractEntrypointID,
        gas_limit: u64,
        calldata: &[u8],
    ) -> BytesM {
        self.authorize(Category::Medium);
        let mut return_buf = ReturnBuf::new();
        let mut returned_tokens = AuthHandleBuf::new();
        match contract_call(
            target,
            entrypoint,
            gas_limit,
            calldata,
            &AuthHandleBuf::new(),
            InvokeFlagSet::default(),
            &mut return_buf,
            &mut returned_tokens,
        ) {
            Ok(CallOutcome::Return) => BytesM(return_buf.as_ref().to_vec()),
            Ok(CallOutcome::Abort) => contract_abort(return_buf.as_ref()),
            Err(_) => throw(AccountError::CallFaulted),
        }
    }
```

If `ReturnBuf::new()` does not exist, use `ReturnBuf::default()`. If `InvokeFlagSet::default()` does not exist, pass `0` as hogd's `dev_wallet` does.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p stellar-account --test account`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/stellar-account
git commit -m "feat(stellar-account): invoke passthrough"
```

---

### Task 6: Factory contract

**Files:**
- Create: `contracts/stellar-account-factory/Cargo.toml`
- Create: `contracts/stellar-account-factory/src/main.rs`
- Create: `contracts/stellar-account-factory/src/lib.rs`
- Create: `contracts/stellar-account-factory/tests/factory.rs`
- Modify: `contracts/stellar-account/Cargo.toml` (uncomment the `stellar-account-factory` dev-dependency)

**Interfaces:**
- Consumes: everything from Task 1; `StellarAccountClient`, `AccountInitError` from Task 2.
- Produces: `StellarAccountFactoryContract` implementing `StellarAccountFactory`; `register_mock_contract`.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "stellar-account-factory"
description = "Deterministic deployment of Stellar-classic accounts from a master key"
version = "0.1.0"
edition.workspace = true
authors.workspace = true
license.workspace = true
publish.workspace = true
repository.workspace = true
homepage.workspace = true
keywords.workspace = true
categories.workspace = true

[features]
entrypoints = []
dev = [
    "sdk/dev",
    "groundhog-erc20-if/dev",
    "stellar-account-factory-if/dev",
]

[lib]
crate-type = ["rlib"]
doctest = false
test = false

[[bin]]
name = "stellar_account_factory"
path = "src/main.rs"
required-features = ["entrypoints"]
test = false
bench = false

[dependencies]
sdk = { workspace = true }
groundhog-erc20-if = { workspace = true }
stellar-account-factory-if = { path = "../../interfaces/stellar-account-factory-if", version = "=0.1.0" }

[dev-dependencies]
stellar-account-factory = { path = ".", features = ["dev"] }
stellar-account = { path = "../stellar-account", features = ["dev"] }
erc20 = { path = "../erc20", features = ["dev"] }
ed25519-dalek = { workspace = true }
groundhog-signing = { workspace = true }
```

- [ ] **Step 2: Write `src/main.rs`**

```rust
//! RV32 binary wrapper for the `stellar-account-factory` contract library.
//! See `stellar-account/src/main.rs` for why this file is just a reference.

#![no_std]
#![no_main]

extern crate stellar_account_factory;
```

- [ ] **Step 3: Write `src/lib.rs`**

```rust
//! Deploys Stellar-classic accounts at an address that is a function of the
//! master key, and initializes each one before its own frame ends, so no
//! account is ever observable uninitialized.
//!
//! hogd charges a deployment's storage to the deployed address, so the
//! predicted address must already hold `required_funding` of the native
//! token. That is Stellar's starting balance: a creator pays it to
//! `address_of(master_key)` and then calls `create_account`.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use groundhog_erc20_if::{CONTRACT_ADDR_ZERO, ERC20Client};
use sdk::storage::Value;
use sdk::*;
pub use stellar_account_factory_if::{
    AccountCreated, AccountFactoryError, FactoryConfig, StellarAccountFactory,
    StellarAccountFactoryClient, StellarAccountInitializerClient, account_address,
    deployment_nonce,
};

#[sdk::storage]
pub struct StellarAccountFactoryContract {
    config: Value<FactoryConfig>,
}

impl StellarAccountFactoryContract {
    fn predicted(config: &FactoryConfig, master_key: &Ed25519PublicKey) -> ContractAddress {
        account_address(&get_current_address(), &config.account_code_hash, master_key)
    }
}

#[contract(exports = "stellar_account_factory_exports")]
impl StellarAccountFactory for StellarAccountFactoryContract {
    fn initialize(&mut self, config: FactoryConfig) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(AccountFactoryError::AlreadyInitialized);
        }
        ensure(
            config.account_code_hash != SHA256Hash::new([0; 32])
                && config.native_token != *CONTRACT_ADDR_ZERO
                && config.required_funding >= 1,
            AccountFactoryError::InvalidConfig,
        );
        self.config.set_exclusive(&config);
    }

    fn create_account(&mut self, master_key: &Ed25519PublicKey) -> ContractAddress {
        let config = self.config.get();
        let predicted = Self::predicted(&config, master_key);
        ensure(
            ERC20Client::new(&config.native_token).get_balance_of(&predicted)
                >= config.required_funding,
            AccountFactoryError::InsufficientFunding,
        );

        let account = deploy_contract(&deployment_nonce(master_key), &config.account_code_hash);
        ensure(account == predicted, AccountFactoryError::AddressMismatch);
        StellarAccountInitializerClient::new(&account).initialize(master_key);

        log_event(&AccountCreated {
            account,
            master_key: *master_key,
        });
        account
    }

    fn address_of(&self, master_key: &Ed25519PublicKey) -> ContractAddress {
        Self::predicted(&self.config.get(), master_key)
    }

    fn config(&self) -> FactoryConfig {
        self.config.get()
    }
}
```

- [ ] **Step 4: Write `tests/factory.rs`**

```rust
//! Creation and derivation on the native executor. ROOT is a plain caller;
//! the native token is the `erc20` example.

use ed25519_dalek::SigningKey;
use sdk::call::RawCallError;
use sdk::*;
use stellar_account::{AccountInitError, StellarAccountClient, Thresholds, MAX_SIGNERS};
use stellar_account_factory::{
    AccountCreated, AccountFactoryError, FactoryConfig, StellarAccountFactoryClient,
    StellarAccountInitializerClient,
};

const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
const FACTORY: ContractAddress = ContractAddress::new([0x50; 32]);
const NATIVE: ContractAddress = ContractAddress::new([0x60; 32]);
const REQUIRED_FUNDING: u128 = 100;

fn key(seed: u8) -> Ed25519PublicKey {
    Ed25519PublicKey::from(SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes())
}

struct Setup {
    env: TestEnvironmentHandle,
    account_hash: SHA256Hash,
}

fn setup() -> Setup {
    let env = TestEnvironment::no_cost();
    let account_hash = *stellar_account::register_mock_contract(&env).as_hash();
    stellar_account_factory::register_mock_contract(&env).deploy_contract_to(&FACTORY);
    erc20::register_mock_contract(&env).deploy_contract_to(&NATIVE);
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native = erc20::ERC20Client::new(&NATIVE);
            native.initialize(&ROOT);
            native.mint(&ROOT, 1_000_000);
            StellarAccountFactoryClient::new(&FACTORY).initialize(FactoryConfig {
                account_code_hash: account_hash,
                native_token: NATIVE,
                required_funding: REQUIRED_FUNDING,
            });
        })
    })
    .assert_success();
    env.advance_block();
    Setup { env, account_hash }
}

fn address_of(s: &Setup, master: Ed25519PublicKey) -> ContractAddress {
    let r = s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountFactoryClient::new(&FACTORY).address_of(&master))
    });
    r.assert_success();
    r.assert_return_as()
}

fn fund(s: &Setup, to: ContractAddress, amount: u128) {
    s.env
        .transact(|tx| tx.call(&ROOT).run(move || erc20::ERC20Client::new(&NATIVE).transfer(&to, amount)))
        .assert_success();
    s.env.advance_block();
}

fn create(s: &Setup, master: Ed25519PublicKey) -> TransactResult {
    s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountFactoryClient::new(&FACTORY).create_account(&master))
    })
}

fn assert_factory_error(result: &TransactResult, expected: AccountFactoryError) {
    result.assert_abort();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(e)) => assert_eq!(e.try_as::<AccountFactoryError>(), Some(expected)),
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn create_account_lands_at_address_of_and_initializes_in_the_same_frame() {
    let s = setup();
    let master = key(0x11);
    let predicted = address_of(&s, master);
    let account_hash = s.account_hash;
    let helper = s.env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            stellar_account_factory::account_address(&FACTORY, &account_hash, &master)
        })
    });
    helper.assert_success();
    assert_eq!(
        helper.assert_return_as::<ContractAddress>(),
        predicted,
        "the pure helper agrees with the view"
    );
    fund(&s, predicted, REQUIRED_FUNDING);

    let result = create(&s, master);
    result.assert_success();
    assert_eq!(result.assert_return_as::<ContractAddress>(), predicted);
    assert_eq!(result.filter_events::<AccountCreated>(&FACTORY).len(), 1);
    s.env.advance_block();

    let state = s.env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            let a = StellarAccountClient::new(&predicted);
            (a.master_key(), a.thresholds(), a.signer_weights())
        })
    });
    state.assert_success();
    let (k, t, w): (Ed25519PublicKey, Thresholds, [u32; MAX_SIGNERS]) = state.assert_return_as();
    assert_eq!(k, master);
    assert_eq!(t, Thresholds { low: 1, medium: 1, high: 1 });
    assert_eq!(w[0], 1);
    assert!(w[1..].iter().all(|x| *x == 0));
}

#[test]
fn an_unfunded_prediction_is_refused() {
    let s = setup();
    let master = key(0x12);
    fund(&s, address_of(&s, master), REQUIRED_FUNDING - 1);
    assert_factory_error(&create(&s, master), AccountFactoryError::InsufficientFunding);
}

#[test]
fn a_created_account_cannot_be_initialized_again() {
    let s = setup();
    let master = key(0x13);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    s.env
        .transact(|tx| {
            tx.call(&ROOT).run(move || {
                let r = StellarAccountInitializerClient::new(&account).try_initialize(&key(0x14));
                assert_eq!(r.unwrap_err().try_as(), Some(AccountInitError::AlreadyInitialized));
            })
        })
        .assert_success();
}

#[test]
fn the_same_master_key_cannot_be_created_twice() {
    let s = setup();
    let master = key(0x15);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    fund(&s, account, REQUIRED_FUNDING);
    let second = create(&s, master);
    second.assert_abort();
}

#[test]
fn factory_initialize_validates_and_runs_once() {
    let s = setup();
    let again = s.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StellarAccountFactoryClient::new(&FACTORY).initialize(FactoryConfig {
                account_code_hash: s.account_hash,
                native_token: NATIVE,
                required_funding: 1,
            })
        })
    });
    assert_factory_error_unit(&again, AccountFactoryError::AlreadyInitialized);

    let fresh = ContractAddress::new([0x51; 32]);
    stellar_account_factory::register_mock_contract(&s.env).deploy_contract_to(&fresh);
    let bad = s.env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            StellarAccountFactoryClient::new(&fresh).initialize(FactoryConfig {
                account_code_hash: s.account_hash,
                native_token: NATIVE,
                required_funding: 0,
            })
        })
    });
    assert_factory_error_unit(&bad, AccountFactoryError::InvalidConfig);
}

fn assert_factory_error_unit(result: &TransactResult, expected: AccountFactoryError) {
    result.assert_abort();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(e)) => assert_eq!(e.try_as::<AccountFactoryError>(), Some(expected)),
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn the_master_key_formats_as_a_stellar_g_strkey() {
    let s = setup();
    let master = key(0x16);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    let got = s.env.transact(|tx| tx.call(&ROOT).run(move || StellarAccountClient::new(&account).master_key()));
    got.assert_success();
    let got: Ed25519PublicKey = got.assert_return_as();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(got.as_ref());
    let g = groundhog_signing::format_public_key(&bytes);
    assert!(g.starts_with('G'), "{g}");
    assert_eq!(groundhog_signing::parse_public_key(&g).unwrap(), bytes);
}
```

- [ ] **Step 5: Uncomment the dev-dependency in `contracts/stellar-account/Cargo.toml`**

`stellar-account-factory = { path = "../stellar-account-factory", features = ["dev"] }`

- [ ] **Step 6: Run**

Run: `cargo test -p stellar-account-factory --test factory && cargo test -p stellar-account --test account`
Expected: all pass. If `the_same_master_key_cannot_be_created_twice` fails because the mock allows redeploying to an occupied address, change its assertion to check that the account's `master_key` is unchanged and note it in the test doc comment.

- [ ] **Step 7: Commit**

```bash
git add contracts/stellar-account-factory contracts/stellar-account/Cargo.toml
git commit -m "feat(stellar-account-factory): deterministic account creation with same-frame initialization"
```

---

### Task 7: The account's `create_account` operation

**Files:**
- Modify: `contracts/stellar-account/src/account.rs`
- Modify: `contracts/stellar-account/tests/account.rs`

**Interfaces:**
- Consumes: `StellarAccountFactoryClient` (`config`, `address_of`, `create_account`) from Task 1.
- Produces: `create_account(&self, factory: &ContractAddress, master_key: &Ed25519PublicKey, starting_balance: u128) -> ContractAddress`, medium threshold.

- [ ] **Step 1: Write the failing test**

Append to `tests/account.rs`:

```rust
const FACTORY: ContractAddress = ContractAddress::new([0x50; 32]);
const STARTING_BALANCE: u128 = 300;

/// A factory whose native token is `TOKEN`, so the account's `MINTED`
/// balance is what funds a new account. `account_hash` comes from
/// `setup_with_hash()`; the account package is registered only there.
fn setup_factory(env: &TestEnvironmentHandle, account_hash: SHA256Hash) {
    stellar_account_factory::register_mock_contract(env).deploy_contract_to(&FACTORY);
    env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            stellar_account_factory::StellarAccountFactoryClient::new(&FACTORY).initialize(
                stellar_account_factory::FactoryConfig {
                    account_code_hash: account_hash,
                    native_token: TOKEN,
                    required_funding: STARTING_BALANCE,
                },
            )
        })
    })
    .assert_success();
    env.advance_block();
}

#[test]
fn create_account_funds_and_creates_a_second_account_in_one_frame() {
    let (env, account_hash) = setup_with_hash();
    setup_factory(&env, account_hash);
    let result = as_account(
        &env,
        claim(1),
        &(FACTORY, second_key(), STARTING_BALANCE),
        stellar_account::stellar_account_exports::create_account_internal,
    );
    result.assert_success();
    let created: ContractAddress = result.assert_return_as();
    assert_eq!(result.filter_events::<stellar_account::AccountCreated>(&FACTORY).len(), 1);
    env.advance_block();

    assert_eq!(balance_of(&env, created), STARTING_BALANCE);
    assert_eq!(balance_of(&env, ACCOUNT), MINTED - STARTING_BALANCE);
    let key = env.transact(|tx| tx.call(&ROOT).run(move || StellarAccountClient::new(&created).master_key()));
    key.assert_success();
    assert_eq!(key.assert_return_as::<Ed25519PublicKey>(), second_key());
}

#[test]
fn create_account_with_too_small_a_starting_balance_fails_whole() {
    let (env, account_hash) = setup_with_hash();
    setup_factory(&env, account_hash);
    let result = as_account(
        &env,
        claim(1),
        &(FACTORY, second_key(), STARTING_BALANCE - 1),
        stellar_account::stellar_account_exports::create_account_internal,
    );
    result.assert_abort();
    env.advance_block();
    assert_eq!(balance_of(&env, ACCOUNT), MINTED, "the prefund was rolled back too");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p stellar-account --test account create_account`
Expected: compile error, `create_account_internal` not found.

- [ ] **Step 3: Implement**

Add `use stellar_account_factory_if::StellarAccountFactoryClient;` to `src/account.rs` imports, and in the exports block:

```rust
    /// Stellar's `create_account`: pay `starting_balance` of the factory's
    /// native token to the new account's address, then have the factory
    /// deploy and initialize it. One frame, so a refusal anywhere leaves no
    /// trace. Medium threshold.
    pub fn create_account(
        &self,
        factory: &ContractAddress,
        master_key: &Ed25519PublicKey,
        starting_balance: u128,
    ) -> ContractAddress {
        self.authorize(Category::Medium);
        let factory = StellarAccountFactoryClient::new(factory);
        let native_token = factory.config().native_token;
        let predicted = factory.address_of(master_key);
        ERC20Client::new(&native_token).transfer(&predicted, starting_balance);
        factory.create_account(master_key)
    }
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p stellar-account --test account`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/stellar-account
git commit -m "feat(stellar-account): create_account operation through the factory"
```

---

### Task 8: Live devnode test with a two-signature transaction (`#[ignore]`d)

**Files:**
- Create: `contracts/stellar-account/tests/testkit_account.rs`

**Interfaces:**
- Consumes: built artifacts `stellar_account.rv32a`, `stellar_account_factory.rv32a`; `groundhog_testkit::{Scenario, Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, entrypoint_id}`; `groundhog_signing::{BuildCallTransaction, build_call_transaction, LocalSigner, Signer, encode_signed_transaction_xdr}`; `groundhog_domain_separator::transaction_signature_preimage`.

- [ ] **Step 1: Write the test**

```rust
//! The account on a live `hog-devnode`: the chain's own weight check, which
//! the native mock does not perform.
//!
//! An `admin` agent registers the account code, deploys and configures the
//! factory, funds the predicted address with native HOG, and creates an
//! account for a test-only master key. Then it drives the account directly
//! with hand-built transactions whose invoked address is the account and
//! whose auth claim is a source-address claim: add a second signer at
//! weight 1, raise the high threshold to 2, and show that a threshold change
//! signed by the master alone is refused at admission while one signed by
//! both keys lands.
//!
//! `#[ignore]`d because it needs a devnode binary and built artifacts:
//!
//! ```text
//! cd groundhog-examples
//! for c in stellar-account stellar-account-factory; do groundhog build -p "$c"; done
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p stellar-account --test testkit_account -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::Duration;

use groundhog_domain_separator::transaction_signature_preimage;
use groundhog_json_rpc_client::GroundhogApiClient;
use groundhog_signing::{
    BuildCallTransaction, LocalSigner, Signer, build_call_transaction,
    encode_signed_transaction_xdr,
};
use groundhog_testkit::xdr::auth_claim::{AuthClaim, AuthClaim_source_address_claim};
use groundhog_testkit::xdr::transaction::{DecoratedSignature, SignedTransaction};
use groundhog_testkit::xdr::types::{ContractAddress, Ed25519PublicKey};
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, Scenario, entrypoint_id,
    xdrs,
};

type Address = ContractAddress;

const ACCOUNT_IF: (&str, &str) = ("StellarAccount", "0.1.0");
const FACTORY_IF: (&str, &str) = ("StellarAccountFactory", "0.1.0");
const ERC20: (&str, &str) = ("ERC20", "0.1.3");

const MASTER_SEED: [u8; 32] = [0x11; 32];
const SECOND_SEED: [u8; 32] = [0x22; 32];

/// Starting balance for the account: covers deployment storage, the
/// account's own storage writes, and gas for the transactions below.
const STARTING_BALANCE: u128 = 5_000_000_000;
const REQUIRED_FUNDING: u128 = 1_000_000_000;
const GAS_LIMIT: u64 = 10_000_000;
const HORIZON: i64 = 1_000;

fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), ERC20.0, ERC20.1)
}

fn public_key(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(LocalSigner::from_secret_key(*seed).verifying_key_bytes())
}

fn source_claim(required_weight: u32) -> AuthClaim {
    AuthClaim::kSourceAddressAuthData {
        source_address_claim: AuthClaim_source_address_claim {
            allowed_keys: 0xFFFF_FFFF,
            required_weight,
        },
    }
}

async fn network_hash(ctx: &AgentContext) -> groundhog_testkit::xdr::types::NetworkHash {
    let client = ctx.network().client().expect("a local network has an RPC client");
    let info = client.network_info().await.expect("networkInfo answers");
    let hex = serde_json::to_value(info.network_hash).expect("serializes");
    let hex = hex.as_str().expect("hex string");
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex.trim_start_matches("0x"), &mut bytes).expect("32 bytes");
    groundhog_testkit::xdr::types::NetworkHash::new(groundhog_testkit::xdr::types::SHA256Hash::new(bytes))
}

/// Build a transaction invoking `method` on `account`, claim `required_weight`,
/// and sign it with every signer in `signers` (slot, key) in slot order.
async fn account_tx<A: xdrs::WriteXDR>(
    ctx: &AgentContext,
    account: Address,
    method: &str,
    args: &A,
    required_weight: u32,
    signers: &[(u32, &LocalSigner)],
    nonce: u64,
) -> String {
    let tip = ctx.network().chain_tip().await.expect("chain tip").height;
    let tx = build_call_transaction(BuildCallTransaction {
        invoked_address: account,
        entrypoint: entrypoint_id(ACCOUNT_IF.0, ACCOUNT_IF.1, method),
        calldata: xdrs::cxs::encode(args).expect("encode args"),
        gas_limit: GAS_LIMIT,
        block_expiry_height: i64::from(tip) + HORIZON,
        nonce,
        auth_claim: source_claim(required_weight),
    });
    let network = network_hash(ctx).await;
    let preimage = transaction_signature_preimage(&network, &tx).expect("preimage");
    let signatures = signers
        .iter()
        .map(|(slot, signer)| DecoratedSignature {
            public_key_id: *slot,
            signature: signer.sign(&preimage).expect("sign"),
        })
        .collect::<Vec<_>>();
    let stx = SignedTransaction {
        tx,
        signatures: signatures.try_into().expect("fits"),
    };
    format!("0x{}", hex::encode(encode_signed_transaction_xdr(&stx).expect("encode")))
}

async fn submit_ok(ctx: &AgentContext, tx_hex: String) {
    let hash = ctx.network().submit_raw(tx_hex).await.expect("accepted at admission");
    let receipt = ctx.network().await_receipt(hash).await.expect("receipt");
    assert!(
        matches!(receipt.status, groundhog_json_rpc_types::ExecStatus::Ok),
        "execution ok, got {:?}",
        receipt.status
    );
}

fn admin() -> Agent {
    Agent::new("admin", |mut ctx| async move {
        let native = native_token();
        let master = LocalSigner::from_secret_key(MASTER_SEED);
        let second = LocalSigner::from_secret_key(SECOND_SEED);

        // Code and factory. `register_artifact` deploys a throwaway first
        // instance; only the registered hash matters here.
        ctx.register_artifact("stellar_account").await?;
        let account_hash = ctx.contract_hash("stellar_account")?;
        let factory = Contract::new(
            ctx.deploy_artifact("stellar_account_factory").await?.address,
            FACTORY_IF.0,
            FACTORY_IF.1,
        );
        native.call(&mut ctx, "transfer", &(factory.address(), REQUIRED_FUNDING)).await?;
        factory
            .call(&mut ctx, "initialize", &(account_hash, native.address(), REQUIRED_FUNDING))
            .await?;

        // Create the account for the master key: fund the prediction, then create.
        let master_pk = public_key(&MASTER_SEED);
        let predicted: Address = factory.view(&ctx, "address_of", &master_pk, None).await?;
        native.call(&mut ctx, "transfer", &(predicted, STARTING_BALANCE)).await?;
        let account: Address = factory.call_returning(&mut ctx, "create_account", &master_pk).await?;
        assert_eq!(account, predicted, "created where predicted");
        let account_c = Contract::new(account, ACCOUNT_IF.0, ACCOUNT_IF.1);
        let reported: Ed25519PublicKey = account_c.view(&ctx, "master_key", &(), None).await?;
        assert_eq!(reported, master_pk);

        // Master alone (weight 1, every threshold 1): add a second signer.
        let tx = account_tx(&ctx, account, "set_signer", &(1u32, public_key(&SECOND_SEED), 1u32), 1, &[(0, &master)], 1).await;
        submit_ok(&ctx, tx).await;

        // Raise high to 2 (total weight is now 2). Still a weight-1 operation.
        let tx = account_tx(&ctx, account, "set_thresholds", &(1u32, 1u32, 2u32), 1, &[(0, &master)], 2).await;
        submit_ok(&ctx, tx).await;

        // A high-threshold change signed by the master alone cannot clear the
        // claimed weight of 2: hogd refuses it before execution.
        let tx = account_tx(&ctx, account, "set_thresholds", &(1u32, 1u32, 1u32), 2, &[(0, &master)], 3).await;
        match ctx.network().submit_raw(tx).await {
            Err(_) => {}
            Ok(hash) => {
                let receipt = ctx.network().await_receipt(hash).await;
                assert!(receipt.is_err() || !matches!(receipt.unwrap().status, groundhog_json_rpc_types::ExecStatus::Ok),
                    "an under-weight transaction must not execute");
            }
        }

        // Claiming only 1 for the same change is refused by the account itself.
        let tx = account_tx(&ctx, account, "set_thresholds", &(1u32, 1u32, 1u32), 1, &[(0, &master)], 4).await;
        let hash = ctx.network().submit_raw(tx).await.expect("admitted: weight 1 is satisfied");
        let receipt = ctx.network().await_receipt(hash).await.expect("receipt");
        assert!(!matches!(receipt.status, groundhog_json_rpc_types::ExecStatus::Ok), "InsufficientAuthWeight");

        // Both keys, claim 2: lands.
        let tx = account_tx(&ctx, account, "set_thresholds", &(1u32, 1u32, 1u32), 2, &[(0, &master), (1, &second)], 5).await;
        submit_ok(&ctx, tx).await;

        // A medium op signed by the second signer alone.
        let me = ctx.address();
        let tx = account_tx(&ctx, account, "payment", &(native.address(), me, 1u128), 1, &[(1, &second)], 6).await;
        submit_ok(&ctx, tx).await;

        println!("admin: account {account:?} created, two-signer threshold change landed");
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and built stellar_account/stellar_account_factory artifacts in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn two_signer_threshold_change_on_a_live_node() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    config.dev_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder("stellar-account-live")
        .network(NetworkConfig::local(config))
        .artifact("stellar_account", artifact("stellar_account.rv32a"))
        .artifact("stellar_account_factory", artifact("stellar_account_factory.rv32a"))
        .build()
        .await
        .expect("local node starts");

    scenario.run_agents([admin()]).await.expect("agent runs to completion");
    scenario.stop().await.expect("clean teardown");
}
```

Fix-ups the implementer should expect: `ChainTip.height` may be a newtype; use `.height.into()` or `*tip.height` as `testkit_permit.rs` does. If `AuthClaim_source_address_claim` is not reachable through `groundhog_testkit::xdr`, import it from `groundhog_xdr::auth_claim` (already a dev-dependency). `ExecStatus` lives in `groundhog_json_rpc_types`; adjust the path to wherever `TransactionReceipt.status` is typed. If the testkit types `ContractAddress` differently from `groundhog_signing`'s, convert via 32-byte copy as `sdk_address` does in `testkit_permit.rs`.

- [ ] **Step 2: Compile the test without running it**

Run: `cargo test -p stellar-account --test testkit_account --no-run`
Expected: compiles. Then `cargo test -p stellar-account --test testkit_account` runs zero tests (ignored) and passes.

- [ ] **Step 3: If a devnode and artifacts are available, run it**

Run the command from the module docs. Expected: `admin: account ... two-signer threshold change landed`. If no devnode is available, say so in the commit message; do not claim it ran.

- [ ] **Step 4: Commit**

```bash
git add contracts/stellar-account/tests/testkit_account.rs
git commit -m "test(stellar-account): live two-signer threshold change on a devnode (ignored)"
```

---

### Task 9: Documentation and spec touch-up

**Files:**
- Create: `contracts/stellar-account/README.md`
- Modify: `README.md` (examples table after the `speedex` row at line 35; validity table after `standard-token-factory-if` at line 232)
- Modify: `docs/superpowers/specs/2026-09-30-stellar-account-design.md`

- [ ] **Step 1: Write `contracts/stellar-account/README.md`**

```markdown
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
| Any other operation | `invoke(target, entrypoint, gas, calldata)`: raw passthrough. |

Signer and threshold changes are high threshold; everything else is medium; low is stored but
unused by any shipped operation. A change that would leave the summed weights below the high
threshold, or any threshold below 1, is refused (`WouldLockOut`).

Every operation must be the transaction's root invocation. The auth claim is verified against the
invoked address's registration, so a claim observed from another contract's frame says nothing
about this account's signers.

Registration writes land with the block: a signer change is in force from the next block, and a
transaction sharing a block with the change is judged against the old set.

## What is not Stellar here

No sequence numbers (the transaction uniquifier covers replay). No trustlines or non-native
assets beyond ERC20 addresses. No data entries, flags, home domain, sponsorship, pre-auth or
hash-x signers. No Stellar XDR envelopes: transactions are Groundhog transactions signed by the
registered keys.
```

- [ ] **Step 2: Add rows to the top-level `README.md`**

After the `speedex` row in the examples table:

```markdown
| [`stellar-account`](contracts/stellar-account/), [`stellar-account-factory`](contracts/stellar-account-factory/), [`stellar-account-factory-if`](interfaces/stellar-account-factory-if/) | Stellar classic's account model on the protocol's native weighted keys: a fixed master key, 20 weighted signers, low/medium/high thresholds enforced through the transaction's claimed weight, `payment`, `create_account`, and a factory that derives the account address from the `G` key |
```

After the `standard-token-factory-if` row in the validity table:

```markdown
| [`stellar-account`](contracts/stellar-account/) | ✅ | — | — |
| [`stellar-account-factory`](contracts/stellar-account-factory/) | ✅ | — | — |
| [`stellar-account-factory-if`](interfaces/stellar-account-factory-if/) | — | — | — |
```

- [ ] **Step 3: Touch up the spec to match what was built**

In `docs/superpowers/specs/2026-09-30-stellar-account-design.md`:
- Under "Address derivation", replace `sha256(master_key)` with "a domain-tagged hash of the master key (`deployment_nonce`, domain `groundhog-stellar-account-factory-v1`)".
- Under "Errors", move `AlreadyInitialized` out of the account list into a note: "`AccountInitError::AlreadyInitialized = 1` lives in the interface crate with the initializer trait." Renumber the account errors as built: `NotRootInvocation = 1`, `InsufficientAuthWeight = 2`, `InvalidSlot = 3`, `ZeroWeight = 4`, `WouldLockOut = 5`, `CallFaulted = 6`.
- Under "Factory entry points", replace the three-argument `initialize` with `initialize(config: FactoryConfig)` and add the `config()` view.
- Under "Open risk", replace the paragraph with the actual outcome of Task 2 Step 7.
- Set `Status: Implemented` at the top.

- [ ] **Step 4: Full verification**

Run: `cargo fmt --all -- --check && cargo clippy -p stellar-account -p stellar-account-factory -p stellar-account-factory-if --all-features -- -D warnings && cargo test -p stellar-account -p stellar-account-factory`
Expected: all clean and passing. Also `cargo build -p stellar-account -p stellar-account-factory --features entrypoints --target riscv32im-unknown-none-elf` if the target is installed (it is in `rust-toolchain.toml`); if that fails on the `alloc` feature, fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add contracts/stellar-account/README.md README.md docs/superpowers/specs/2026-09-30-stellar-account-design.md
git commit -m "docs: stellar-account README, example table rows, spec status"
```
