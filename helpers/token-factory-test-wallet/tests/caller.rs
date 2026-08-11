use sdk::*;
use token_factory_test_if::TokenFactoryTestWalletClient;

const ROOT: ContractAddress = ContractAddress::new([0x11; 32]);
const WALLET_NONCE: SHA256Hash = SHA256Hash::new([0x22; 32]);
const CHILD_NONCE: SHA256Hash = SHA256Hash::new([0x33; 32]);

#[test]
fn child_observes_wallet_as_immediate_caller() {
    let env = TestEnvironment::no_cost();
    let wallet_hash = *token_factory_test_wallet::register_mock_contract(&env).as_hash();
    let child_hash = *token_factory_failing_child::register_mock_contract(&env).as_hash();

    let result = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let wallet = deploy_contract(&WALLET_NONCE, &wallet_hash);
            let child = deploy_contract(&CHILD_NONCE, &child_hash);
            let observed = TokenFactoryTestWalletClient::new(&wallet).probe_caller(&child);
            (wallet, observed)
        })
    });

    result.assert_success();
    result.assert_return_with::<(ContractAddress, ContractAddress)>(|(wallet, observed)| {
        assert_eq!(observed, wallet);
    });
}
