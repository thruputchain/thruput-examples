//! The account contract: storage, authorization preamble, entry points.

use groundhog_erc20_if::ERC20Client;
use sdk::call::{CallOutcome, ReturnBuf, contract_call};
use sdk::storage::Value;
use sdk::sys::{SyscallErrorCode, SyscallNo};
use sdk::*;
use stellar_account_factory_if::{
    AccountInitError, StellarAccountFactoryClient, StellarAccountInitializer,
};

// `AccountError` is imported because the `throws = AccountError` macro attribute references it by
// name in generated code; `SignerChanged`/`ThresholdsChanged` are imported because the `log_event`
// calls in the method bodies use them directly (the `emits(...)` attribute alone would not require
// the event types to be in scope here).
use crate::{
    AccountConfig, AccountError, MAX_SIGNERS, SignerChanged, Thresholds, ThresholdsChanged,
};

#[sdk::storage]
pub struct StellarAccount {
    config: Value<AccountConfig>,
}

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
            Ok(AuthClaim::kSourceAddressAuthData {
                source_address_claim,
            }) if source_address_claim.required_weight >= threshold => {}
            _ => throw(AccountError::InsufficientAuthWeight),
        }
        config
    }

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

    /// The lockout guard, then the write. Every threshold must be at least 1
    /// and the sum of the mirrored weights must reach the largest of them, so
    /// every category stays satisfiable. `low` matters most: it is the
    /// chain-enforced required weight, so a `low` above the total would keep
    /// hogd from admitting any transaction again, and a `low` of 0 would let
    /// an unsigned one through. On refusal the frame reverts, including any
    /// registration syscall already issued.
    fn commit(&mut self, config: &AccountConfig) {
        let total: u64 = config.weights.iter().map(|w| u64::from(*w)).sum();
        let t = config.thresholds;
        ensure(
            t.low >= 1
                && t.medium >= 1
                && t.high >= 1
                && total >= u64::from(t.low.max(t.medium).max(t.high)),
            AccountError::WouldLockOut,
        );
        self.config.set(config);
    }

    /// A slot other than the master's, inside the table.
    fn check_signer_slot(slot: u32) {
        ensure(
            slot >= 1 && (slot as usize) < MAX_SIGNERS,
            AccountError::InvalidSlot,
        );
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
            thresholds: Thresholds {
                low: 1,
                medium: 1,
                high: 1,
            },
            weights,
        });
    }
}

#[contract(
    client = StellarAccountClient,
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

    /// Stellar's `payment`: an ERC20 transfer from this account. Native HOG
    /// is the ERC20 at `sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN`.
    /// Medium threshold.
    pub fn payment(&self, asset: &ContractAddress, to: &ContractAddress, amount: u128) {
        self.authorize(Category::Medium);
        ERC20Client::new(asset).transfer(to, amount);
    }

    /// Stellar `set_options` adding or replacing a signer. Slot 0 is the
    /// master key and cannot be re-keyed, and the master key cannot take a
    /// second slot (that would count its weight twice). High threshold.
    pub fn set_signer(&mut self, slot: u32, key: &Ed25519PublicKey, weight: u32) {
        let mut config = self.authorize(Category::High);
        Self::check_signer_slot(slot);
        ensure(weight >= 1, AccountError::ZeroWeight);
        ensure(*key != config.master_key, AccountError::InvalidSlot);
        Self::register(slot, key, weight);
        config.weights[slot as usize] = weight;
        self.commit(&config);
        log_event(&SignerChanged { slot, weight });
    }

    /// Stellar `set_options` removing a signer (weight 0). High threshold.
    pub fn remove_signer(&mut self, slot: u32) {
        let mut config = self.authorize(Category::High);
        Self::check_signer_slot(slot);
        ensure(
            config.weights[slot as usize] != 0,
            AccountError::InvalidSlot,
        );
        Self::deregister(slot);
        config.weights[slot as usize] = 0;
        self.commit(&config);
        log_event(&SignerChanged { slot, weight: 0 });
    }

    /// Stellar's master weight. 0 deregisters slot 0 (refused if it is
    /// already empty); any other value registers the stored master key with
    /// that weight. High threshold.
    pub fn set_master_weight(&mut self, weight: u32) {
        let mut config = self.authorize(Category::High);
        ensure(
            weight != 0 || config.weights[0] != 0,
            AccountError::InvalidSlot,
        );
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
            Ok(CallOutcome::Return) => BytesM(return_buf.as_slice().to_vec()),
            Ok(CallOutcome::Abort) => contract_abort(return_buf.as_slice()),
            Err(_) => throw(AccountError::CallFaulted),
        }
    }
}

/// Public bridge so external tests can call raw entry points via
/// `stellar_account::stellar_account_exports::*_internal`.
#[cfg(feature = "dev")]
pub mod stellar_account_exports_pub {
    pub use super::stellar_account_exports::*;
}
