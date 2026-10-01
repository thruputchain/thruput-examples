//! The account contract: storage, authorization preamble, entry points.

use sdk::storage::Value;
use sdk::sys::SyscallNo;
use sdk::*;
use stellar_account_factory_if::{AccountInitError, StellarAccountInitializer};

use crate::{AccountConfig, AccountError, MAX_SIGNERS, Thresholds};

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
}
