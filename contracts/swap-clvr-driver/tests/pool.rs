//! The CLVR driver in front of a real pool: a handler, its LP token, and two ERC20s.
//!
//! The ordering rule itself is tested in `src/clvr.rs`, against a full scan. These check what only a
//! pool can show: that the driver hands the handler its batch in that order, and that the reserves
//! it orders by are the pool's.

use swap_clvr_driver::*;
use swap_if::*;
use swap_pair::{from_token, to_token};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::*;

hash_ident! { static TEST_ADDR: ContractAddress; }
hash_ident! { static FACTORY_ADDR: ContractAddress; }
// The driver takes requests from the router alone; these tests enqueue as it.
hash_ident! { static ROUTER_ADDR: ContractAddress; }
hash_ident! { static PROVIDER: ContractAddress; }
hash_ident! { static ALICE: ContractAddress; }
hash_ident! { static MALLORY: ContractAddress; }

hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static LP_NONCE: SHA256Hash; }
hash_ident! { static HANDLER_NONCE: SHA256Hash; }
hash_ident! { static DRIVER_NONCE: SHA256Hash; }

const CONTRACT_FUNDING: i64 = 1_000_000_000;
const POOL_DEPTH: Amount = 1_000_000_000_000;
const WALLET: Amount = 100 * POOL_DEPTH;

// A front-run, the victim's trade, and a back-run, as in `src/clvr.rs`.
const FRONT_RUN: Amount = POOL_DEPTH / 50;
const VICTIM: Amount = POOL_DEPTH / 200;
const BACK_RUN: Amount = POOL_DEPTH / 50;

#[derive(Clone)]
struct Pool {
    env: TestEnvironmentHandle,
    tokens: Addresses,
    handler: Address,
    driver: Address,
}

// Without anything to add liquidity with, the trades would all fail; a pool with liquidity, and
// three traders who have let the handler take their tokens.
fn pool() -> Pool {
    pool_with(16)
}

// A pool whose driver holds up to `capacity` requests.
//
// Under `guest_test` the contracts are the RV32 artifacts `thruput build` made (with `erc20` built
// `-F metadata`, as `scripts/build-guest.sh` builds it), run by the mock executor under the
// protocol's limits -- its 64 KiB of guest memory among them.
fn pool_with(capacity: u32) -> Pool {
    let env = TestEnvironment::new(None);

    #[cfg(not(feature = "guest_test"))]
    let (token_hash, handler_hash, driver_hash) = (
        *erc20::register_mock_contract(&env).as_hash(),
        *swap_handler::register_mock_contract(&env).as_hash(),
        *swap_clvr_driver::register_mock_contract(&env).as_hash(),
    );

    #[cfg(feature = "guest_test")]
    let (token_hash, handler_hash, driver_hash) = {
        let load = |name: &str| {
            let path = format!("../../target/thruput/{name}.rv32a");
            env.setup_create_contract(&load_rv32_contract(path))
        };
        (
            load("erc20"),
            load("swap_handler"),
            load("swap_clvr_driver"),
        )
    };

    let accounts: [&ContractAddress; 5] = [&TEST_ADDR, &FACTORY_ADDR, &PROVIDER, &ALICE, &MALLORY];
    for addr in accounts {
        env.setup_grant_storage_tokens(addr, CONTRACT_FUNDING);
    }
    let fund = |deployer: &ContractAddress, nonce: &SHA256Hash, hash: &SHA256Hash| -> Address {
        let addr = exec(&env, deployer, || get_deploy_address(nonce, hash));
        env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
        addr
    };
    fund(&TEST_ADDR, &TOKEN_0_NONCE, &token_hash);
    fund(&TEST_ADDR, &TOKEN_1_NONCE, &token_hash);
    fund(&FACTORY_ADDR, &LP_NONCE, &token_hash);
    fund(&FACTORY_ADDR, &HANDLER_NONCE, &handler_hash);
    let driver = fund(&FACTORY_ADDR, &DRIVER_NONCE, &driver_hash);

    let tokens = exec(&env, &TEST_ADDR, || {
        let tokens = [
            deploy_contract(&TOKEN_0_NONCE, &token_hash),
            deploy_contract(&TOKEN_1_NONCE, &token_hash),
        ];
        for token in &tokens {
            #[cfg(not(feature = "guest_test"))]
            ERC20Client::new(token).initialize(&TEST_ADDR);
            #[cfg(feature = "guest_test")]
            thruput_erc20_metadata_if::ERC20MetadataClient::new(token)
                .initialize(&TEST_ADDR, None, None, None);

            let token = ERC20Client::new(token);
            for user in users() {
                token.mint(user, to_token(WALLET));
            }
        }
        tokens
    });
    env.advance_block();

    // As the factory would: the handler (the pool, adopting its LP token), then its driver.
    let handler = exec(&env, &FACTORY_ADDR, || {
        let lp = deploy_contract(&LP_NONCE, &token_hash);
        let handler = deploy_contract(&HANDLER_NONCE, &handler_hash);
        SwapHandlerClient::new(&handler).initialize(
            &FACTORY_ADDR,
            &tokens[0],
            &tokens[1],
            &lp,
            &driver,
        );
        handler
    });
    env.advance_block();

    exec(&env, &FACTORY_ADDR, || {
        deploy_contract(&DRIVER_NONCE, &driver_hash);
        SwapDriverClient::new(&driver).initialize(&handler, &ROUTER_ADDR, capacity, 4);
    });
    env.advance_block();

    for user in users() {
        exec(&env, user, || {
            for token in &tokens {
                ERC20Client::new(token).adjust_allowance(&handler, to_token(WALLET));
            }
        });
    }
    env.advance_block();

    Pool {
        env,
        tokens,
        handler,
        driver,
    }
}

impl Pool {
    // Enqueue `request`, as the router, in a block of its own.
    fn request(&self, request: SwapRequest) -> RequestId {
        let driver = self.driver;
        let request = std::sync::Mutex::new(Some(request));
        let id = exec(&self.env, &ROUTER_ADDR, move || {
            SwapDriverClient::new(&driver).request(request.lock().unwrap().take().unwrap())
        });
        self.env.advance_block();
        id
    }

    fn provide(&self, amount: Amount) -> RequestId {
        self.request(SwapRequest::add_liquidity(
            &PROVIDER,
            [amount, amount],
            [0, 0],
            &PROVIDER,
        ))
    }

    fn crank(&self) -> TransactResult {
        self.crank_for(8)
    }

    // Crank with gas for a batch of `batch_size`.
    fn crank_for(&self, batch_size: u32) -> TransactResult {
        let driver = self.driver;
        let r = self.env.transact(|tx| {
            tx.call(&TEST_ADDR).run(|| {
                SwapDriverClient::new(&driver)
                    .with_gas_limit(process_requests_gas(batch_size))
                    .process_requests()
            })
        });
        self.env.advance_block();
        r
    }

    fn reserves(&self) -> Amounts {
        let handler = self.handler;
        exec(&self.env, &TEST_ADDR, || {
            SwapHandlerClient::new(&handler).pool_state().reserves
        })
    }

    fn balance(&self, user: &'static ContractAddress, token: usize) -> Amount {
        let token = self.tokens[token];
        exec(&self.env, &TEST_ADDR, || {
            from_token(ERC20Client::new(&token).get_balance_of(user))
        })
    }
}

// The order that matters is not the order of arrival. Queued as a sandwich -- the front-run first,
// then the victim's trade, then the back-run, each in a block of its own -- the batch is handed to
// the pool as CLVR would order it: the victim's trade first, at the price the batch found.
#[test]
fn a_sandwich_comes_apart() {
    let pool = pool();
    pool.provide(POOL_DEPTH);
    pool.crank().assert_success();
    let start = pool.reserves();
    assert_eq!(start, [POOL_DEPTH, POOL_DEPTH]);

    let front = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, FRONT_RUN, 0, 1, &MALLORY,
    ));
    let victim = pool.request(SwapRequest::swap_exact_in(&ALICE, VICTIM, 0, 1, &ALICE));
    let back = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, BACK_RUN, 0, 0, &MALLORY,
    ));

    let crank = pool.crank();
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (3, 0));
    assert_eq!(swap_request_ids(&crank), [victim, back, front]);

    // The victim was filled at p₀, exactly as a lone trade against the starting pool would be.
    let alone = (U256::from(VICTIM) * 997 * U256::from(start[0]))
        / (U256::from(start[1]) * 1000 + U256::from(VICTIM) * 997);
    assert_eq!(
        pool.balance(&ALICE, 0),
        WALLET + Amount::try_from(alone).unwrap()
    );
}

// Liquidity in the same batch as trades goes first, and the trades are then ordered by the reserves
// it left -- which the driver reads from the pool, not from what the batch began with.
//
// Here the batch also brings the pool into being. With the reserves it began with, an empty pool,
// there is no price to order by, and the trades would go in queue order.
#[test]
fn trades_are_ordered_by_the_reserves_liquidity_left() {
    let pool = pool();

    let front = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, FRONT_RUN, 0, 1, &MALLORY,
    ));
    let victim = pool.request(SwapRequest::swap_exact_in(&ALICE, VICTIM, 0, 1, &ALICE));
    let back = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, BACK_RUN, 0, 0, &MALLORY,
    ));
    let provided = pool.provide(POOL_DEPTH);

    let crank = pool.crank();
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (4, 0));
    assert_eq!(mint_request_ids(&crank), [provided]);
    assert_eq!(swap_request_ids(&crank), [victim, back, front]);
}

// A trade that its limit refuses changes nothing, and the batch goes on from the same price -- in
// the model as in the pool, so that the rest of the batch is ordered by reserves the pool really
// has.
#[test]
fn a_refused_trade_leaves_the_order_to_the_rest() {
    let pool = pool();
    pool.provide(POOL_DEPTH);
    pool.crank().assert_success();

    // The victim's trade would go first, but asks for more than it can get, and fails.
    let front = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, FRONT_RUN, 0, 1, &MALLORY,
    ));
    let victim = pool.request(SwapRequest::swap_exact_in(
        &ALICE, VICTIM, VICTIM, 1, &ALICE,
    ));
    let back = pool.request(SwapRequest::swap_exact_in(
        &MALLORY, BACK_RUN, 0, 0, &MALLORY,
    ));

    let crank = pool.crank();
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (3, 1));
    assert_eq!(request_failed_ids(&crank), [victim]);

    // From p₀ again, the smaller of the two moves the price least: they are the same size, so the
    // tie goes to the one queued first.
    assert_eq!(swap_request_ids(&crank), [front, back]);
}

// The declared gas limit is the batch size, as with `swap-driver` -- but here the batch is taken
// whole before any of it is handled, so a crank takes exactly what it budgeted for and leaves the
// rest, earliest first, for the next.
#[test]
fn a_crank_takes_the_batch_it_paid_for() {
    let pool = pool();
    pool.provide(POOL_DEPTH);
    pool.crank().assert_success();

    let ids: Vec<RequestId> = (0..6)
        .map(|i| {
            let size = POOL_DEPTH / 1000 * (1 + i);
            pool.request(SwapRequest::swap_exact_in(
                &ALICE,
                size,
                0,
                i as u32 % 2,
                &ALICE,
            ))
        })
        .collect();

    let first = pool.crank_for(4);
    first.assert_success();
    assert_eq!(first.assert_return_as::<(u32, u32)>(), (4, 0));
    let mut handled = swap_request_ids(&first);
    handled.sort();
    let mut earliest = ids[..4].to_vec();
    earliest.sort();
    assert_eq!(handled, earliest, "the four queued first");

    let second = pool.crank_for(4);
    assert_eq!(second.assert_return_as::<(u32, u32)>(), (2, 0));
}

// The contract sets the least a crank must take: whatever is waiting, up to the pool's
// `min_crank_batch` (4 here). A crank funded for less is refused before it touches the queue, and
// the batch is left for one that pays for it.
#[test]
fn a_crank_owes_what_is_waiting_up_to_the_floor() {
    let pool = pool();
    pool.provide(POOL_DEPTH);
    pool.crank().assert_success();

    for i in 0..4 {
        let size = POOL_DEPTH / 1000 * (1 + i);
        pool.request(SwapRequest::swap_exact_in(
            &ALICE,
            size,
            0,
            i as u32 % 2,
            &ALICE,
        ));
    }

    let driver = pool.driver;
    let refused = exec(&pool.env, &TEST_ADDR, move || {
        SwapDriverClient::new(&driver)
            .with_gas_limit(process_requests_gas(1))
            .try_process_requests()
            .err()
            .and_then(|e| e.try_as::<SwapDriverError>())
    });
    assert_eq!(refused, Some(SwapDriverError::BatchTooSmall));
    pool.env.advance_block();

    let paid = pool.crank_for(4);
    assert_eq!(paid.assert_return_as::<(u32, u32)>(), (4, 0));
}

// The largest batch a crank takes fits in the driver's memory, which holds it whole: `MAX_BATCH`
// trades, ordered and handled in one crank. Natively memory is unbounded, so this shows something
// only under `guest_test`. (`CLVR_BATCH` sets another size, to look for the limit.)
#[test]
fn the_largest_batch_fits() {
    let n: u32 = std::env::var("CLVR_BATCH")
        .map(|v| v.parse().unwrap())
        .unwrap_or(clvr::MAX_BATCH);
    let pool = pool_with(n.max(16));
    pool.provide(POOL_DEPTH);
    pool.crank().assert_success();

    enqueue_trades(&pool, n);

    let crank = pool.crank_for(n);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (n, 0));
}

// Queue `n` small trades, in both directions and of both kinds, each in a block of its own.
fn enqueue_trades(pool: &Pool, n: u32) {
    for i in 0..n {
        let size = POOL_DEPTH / 100_000 * Amount::from(1 + i % 7);
        let in_index = i % 2;
        pool.request(if i / 2 % 2 == 0 {
            SwapRequest::swap_exact_in(&ALICE, size, 0, in_index, &ALICE)
        } else {
            SwapRequest::swap_exact_out(&ALICE, size, Amount::MAX, in_index, &ALICE)
        });
    }
}

/////////////////////// helpers /////////////////////////////////////////////

fn users() -> [&'static ContractAddress; 3] {
    [&PROVIDER, &ALICE, &MALLORY]
}

fn exec<T>(
    env: &TestEnvironmentHandle,
    addr: &ContractAddress,
    f: impl Fn() -> T + std::panic::RefUnwindSafe,
) -> T {
    use std::sync::{Arc, Mutex};

    let out: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));
    env.transact(|tx| {
        tx.call(addr).run(|| {
            *Arc::clone(&out).lock().unwrap() = Some(f());
        })
    })
    .assert_success();

    Arc::into_inner(out).unwrap().into_inner().unwrap().unwrap()
}

// The request ids carried by the `SwapEvent`s a transaction emitted, in order.
fn swap_request_ids(r: &TransactResult) -> Vec<RequestId> {
    use swap_pair::events::SwapEvent;

    let sig = SwapEvent::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .map(|e| {
            TypedEvent::<SwapEvent>::new(e)
                .payload()
                .request_id
                .unwrap()
        })
        .collect()
}

// ... and by its `LiquidityMintEvent`s.
fn mint_request_ids(r: &TransactResult) -> Vec<RequestId> {
    use swap_pair::events::LiquidityMintEvent;

    let sig = LiquidityMintEvent::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .map(|e| {
            TypedEvent::<LiquidityMintEvent>::new(e)
                .payload()
                .request_id
                .unwrap()
        })
        .collect()
}

// The ids carried by the `RequestFailed` events a transaction emitted.
fn request_failed_ids(r: &TransactResult) -> Vec<RequestId> {
    let sig = RequestFailed::signature();
    r.events()
        .iter()
        .filter_map(|e| {
            let e = EmittedEvent::from(e);
            (e.topic(0) == sig).then(|| RequestId::new(*e.topic(1).expect("request_id topic")))
        })
        .collect()
}
