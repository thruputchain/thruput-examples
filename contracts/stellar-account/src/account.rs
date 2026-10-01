//! The account contract: storage, authorization preamble, entry points.

use groundhog_erc20_if::ERC20Client;
use sdk::storage::Value;
use sdk::sys::{SyscallErrorCode, SyscallNo};
use sdk::*;
use stellar_account_factory_if::{AccountInitError, StellarAccountInitializer};

use crate::{AccountConfig, AccountError, MAX_SIGNERS, Thresholds};

#[sdk::storage]
pub struct StellarAccount {
    config: Value<AccountConfig>,
}

/// Stellar's operation categories. Low is stored but no shipped operation
/// uses it.
#[derive(Clone, Copy)]
#[allow(dead_code)]
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
    #[allow(dead_code)]
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
}

/// Public bridge so external tests can call raw entry points via
/// `stellar_account::stellar_account_exports::*_internal`.
pub mod stellar_account_exports_pub {
    pub use super::stellar_account_exports::*;
}
