use super::*;

// Storage tokens granted to each contract under the default cost model, well
// above what these tests spend.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// Deploy nonces, at module scope so a contract's deterministic address can be
// computed (and funded) before it is deployed.
hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static LP_NONCE: SHA256Hash; }

// Under the default cost model a contract pays for the storage it writes.  Grant
// storage tokens to the (deterministic) address `deployer` will deploy `hash` to
// with `nonce`, so the freshly deployed contract is solvent.
fn fund_deploy_target(
    env: &TestEnvironmentHandle,
    deployer: &ContractAddress,
    nonce: &SHA256Hash,
    hash: &SHA256Hash,
) {
    let addr =
        exec_tx(env, deployer, || get_deploy_address(nonce, hash)).expect("compute deploy address");
    env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
}

// These pairs are deployed directly (no factory), so the pair's fee lookup
// finds no factory and the protocol fee is disabled.  Fee behavior is covered
// by the `swap-factory` crate's tests instead.
#[rustfmt::skip]
pub fn setup_etx() -> Result<Etx> {
    let env = thruput_sdk::TestEnvironment::new(None); // use default cost model

    // Register the token contract
    let token_contract = erc20::register_mock_contract(&env);
    let token_hash = *token_contract.as_hash();

    // Pre-fund the test caller and each contract we deploy (at its
    // deterministic address), so their storage writes are solvent under the
    // cost model.
    for u in USERS {
        env.setup_grant_storage_tokens(u.addr, CONTRACT_FUNDING);
    }
    fund_deploy_target(&env, &TEST_ADDR, &TOKEN_0_NONCE, &token_hash);
    fund_deploy_target(&env, &TEST_ADDR, &TOKEN_1_NONCE, &token_hash);
    fund_deploy_target(&env, &FACTORY_ADDR, &LP_NONCE, &token_hash);
    // The pair is code, not a contract, but it still keeps state and holds
    // tokens at an address of its own, and pays for that storage.
    env.setup_grant_storage_tokens(&PAIR_ADDR, CONTRACT_FUNDING);

    // Deploy and init the A/B token contracts
    let token_addrs = exec_tx(&env, &TEST_ADDR, || ab_tokens_deploy_init(&token_hash))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Seed our users with A/B tokens
    exec_tx(&env, &TEST_ADDR, || airdrop_tokens(&token_addrs));

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy the LP token the pair will adopt.
    let liquidity_token = exec_tx(&env, &FACTORY_ADDR, || {
        deploy_contract(&LP_NONCE, &token_hash)
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // Then bring the pair up, in a frame at its own address -- which is what
    // makes it the LP token's administrator and the pool's token holder.
    exec_tx(&env, &PAIR_ADDR, move || {
        let mut pair: Node<Pair> = Keypath::default().into();
        pair.initialize(
            &FACTORY_ADDR,
            &token_addrs[0],
            &token_addrs[1],
            &liquidity_token,
        );
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        pair_addr: PAIR_ADDR,
        liquidity_token,
        token_addrs
    };

    Ok(Etx { env, ctx })
}

#[rustfmt::skip]
pub fn setup_etx_primed() -> Result<Etx> {
    let etx = setup_etx()?;

    // Primer buys liquidity tokens, establishing a stable price
    etx.user_buy(PRIMER)?;

    /* ----- */ etx.advance_block(); /* ----- */

    Ok(etx)
}

// Contract code

// Deploy and init A/B token contracts, given the hash of a registered token
// contract.
fn ab_tokens_deploy_init(token_hash: &SHA256Hash) -> Addresses {
    assert_eq!(&get_current_address(), &TEST_ADDR);

    // Deploy contracts for two tokens that we'd like to swap between
    let token0_addr = deploy_contract(&TOKEN_0_NONCE, token_hash);
    let token1_addr = deploy_contract(&TOKEN_1_NONCE, token_hash);

    let token0 = ERC20Client::new(&token0_addr);
    let token1 = ERC20Client::new(&token1_addr);

    // Initialize the token contracts, putting them under control of the test
    token0.initialize(TEST.addr);
    token1.initialize(TEST.addr);

    [token0_addr, token1_addr]
}

fn airdrop_tokens(token_addrs: &Addresses) {
    let token0 = ERC20Client::new(&token_addrs[0]);
    let token1 = ERC20Client::new(&token_addrs[1]);

    assert_eq!(from_token(token0.get_balance_of(ALICE.addr)), 0);
    assert_eq!(from_token(token1.get_balance_of(ALICE.addr)), 0);

    // Initial airdrops
    for u in USERS {
        token0.mint(u.addr, to_token(u.init.0));
        token1.mint(u.addr, to_token(u.init.1));
    }
}
