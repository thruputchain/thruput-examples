use crate::model::Model;
use erc20::{ERC20BurnClient, ERC20ClawbackClient};
use thruput_erc20_if::*;
use thruput_sdk::*;

#[cfg(feature = "metadata")]
mod metadata {
    pub use thruput_erc20_metadata_if::*;

    pub const TOKEN_NAME: &str = "Test Token";
    pub const TOKEN_SYMBOL: &str = "TEST-TOK";
    pub const TOKEN_DECIMALS: u32 = 18;
}
#[cfg(feature = "metadata")]
use metadata::*;

hash_ident! { static TEST_NONCE: SHA256Hash;  }
hash_ident! { static OTHER_ADMIN_NONCE: SHA256Hash; }
hash_ident! { static OTHER: ContractAddress; }

pub fn erc20_test_setup(target_contract_hash: &SHA256Hash) -> ContractAddress {
    // Deploy the target contract
    deploy_contract(&TEST_NONCE, target_contract_hash)
}

/// Test the logic of an ERC20 contract
pub fn erc20_test(deployed_addr: &ContractAddress) -> Model {
    let owner = get_current_address();
    let other = &OTHER;

    let mut m = Model::default();
    m.initialize(&owner);

    let client = ERC20Client::new(deployed_addr);
    let burn_client = ERC20BurnClient::new(deployed_addr);
    let clawback_client = ERC20ClawbackClient::new(deployed_addr);

    #[cfg(feature = "metadata")]
    {
        let client_meta = ERC20MetadataClient::new(deployed_addr);
        client_meta.initialize(
            &owner,
            Some(TOKEN_NAME.try_into().unwrap()),
            Some(TOKEN_SYMBOL.try_into().unwrap()),
            Some(TOKEN_DECIMALS),
        );

        let name = client_meta.name();
        let symbol = client_meta.symbol();

        assert_eq!(Some(TOKEN_NAME), name.as_ref().map(|n| n.as_str()));
        assert_eq!(Some(TOKEN_SYMBOL), symbol.as_ref().map(|s| s.as_str()));
        assert_eq!(Some(TOKEN_DECIMALS), client_meta.decimals());

        println!("Using token: {TOKEN_NAME} ({TOKEN_SYMBOL}; {TOKEN_DECIMALS} decimals)");
    }

    #[cfg(not(feature = "metadata"))]
    client.initialize(&owner);

    // Mint (an amount != 100, so a hardcoded event amount can't hide)
    let amt = 101;
    client.mint(&owner, amt);
    m.mint(&owner, amt);

    // A negative amount is refused before anything else is checked
    assert_eq!(
        client.try_mint(&owner, -1).unwrap_err().try_as(),
        Some(ERC20Error::NegativeAmount)
    );

    // Burn our own tokens
    let amt = 50;
    burn_client.burn(amt);
    m.clawback(&owner, amt);

    {
        // Burn too much
        let amt = 60;
        assert!(m.balances[&owner] < amt);
        assert_eq!(
            burn_client.try_burn(amt).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
    }

    // Transfer
    let amt = 25;
    client.transfer(other, amt);
    m.transfer(other, amt);

    {
        // Transfer too much
        assert!(m.balances[&owner] < 1000);
        assert_eq!(
            client.try_transfer(other, 1000).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
    }

    // Force a burn from another address: the administrator's clawback
    let amt = 5;
    clawback_client.clawback(other, amt);
    m.clawback(other, amt);

    // Approve spending by "other"
    let amt = 17;
    client.adjust_allowance(other, amt);
    m.adjust_allowance(other, amt);

    // Withdraw too much approval
    assert_eq!(
        client
            .try_adjust_allowance(other, -20)
            .unwrap_err()
            .try_as(),
        Some(ERC20Error::TooLarge)
    );

    // Withdraw some approval
    let amt = 10;
    client.adjust_allowance(other, -amt);
    m.adjust_allowance(other, -amt);

    // Grant some more
    let amt = 3;
    client.adjust_allowance(other, amt);
    m.adjust_allowance(other, amt);

    // Revoke the allowance entirely; the amount removed is reported
    client.delete_allowance(other);
    m.delete_allowance(other);
    assert_eq!(client.allowance(&owner, other), 0);

    // A nonzero balance can't be deleted ...
    let balance = m.balances[&owner];
    assert!(balance > 0);
    assert_eq!(
        client.try_delete_balance().unwrap_err().try_as(),
        Some(ERC20Error::BalanceNotZero)
    );

    // ... but an emptied one can, and reads as zero afterwards
    client.transfer(other, balance);
    m.transfer(other, balance);
    client.delete_balance();
    assert_eq!(client.get_balance(), 0);

    // Check client state against the model
    m.check(&client);

    m
}

/// Test the administrator checks: initialization happens once, and only the
/// configured administrator can mint or claw back.
pub fn erc20_admin_test(target_contract_hash: &SHA256Hash, deployed_addr: &ContractAddress) {
    let caller = get_current_address();

    // `deployed_addr` is already initialized by `erc20_test`
    assert_eq!(
        ERC20Client::new(deployed_addr)
            .try_initialize(&caller)
            .unwrap_err()
            .try_as(),
        Some(ERC20Error::AlreadyInitialized)
    );

    // A second token administered by another address refuses this caller
    let token = deploy_contract(&OTHER_ADMIN_NONCE, target_contract_hash);
    let client = ERC20Client::new(&token);
    client.initialize(&OTHER);
    assert_eq!(
        client.try_mint(&caller, 1).unwrap_err().try_as(),
        Some(ERC20Error::MustBeContractOwner)
    );
    assert_eq!(
        ERC20ClawbackClient::new(&token)
            .try_clawback(&OTHER, 1)
            .unwrap_err()
            .try_as(),
        Some(ERC20Error::MustBeContractOwner)
    );
}
