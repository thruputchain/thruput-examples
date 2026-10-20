//! Factory-specific standard token initialization.

use thruput_erc20_if::{Amount, ERC20Error};
use thruput_erc20_metadata_if::{Name, Symbol};
use thruput_sdk::{ContractAddress, contract};

/// Initialization entrypoint used by a standard token factory immediately
/// after child deployment.
#[contract(client = StandardTokenInitializerClient, throws = ERC20Error)]
pub trait StandardTokenInitializer {
    /// Initializes token metadata, administration, and initial supply once.
    fn initialize_from_factory(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    );
}
