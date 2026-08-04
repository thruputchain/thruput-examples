use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use groundhog_erc20_if::Amount;
use groundhog_erc20_metadata_if::{Name, Symbol};
use groundhog_json_rpc_types::events::{
    BlockAnchor, ContractAddressList, EventFilter, EventFilterList, EventQuery, EventTopicFilter,
    IterationOrder, PaginationCursor, TopicList,
};
use groundhog_json_rpc_types::hex::Topic;
use groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest;
use groundhog_json_rpc_types::view::RootInvocationOutput;
use groundhog_signing::dev_account::derive_dev_account_secret;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, NetworkConfig, Scenario, entrypoint_id, xdrs,
};
use sdk::Event;
use swap_if::{Suite, SwapHashes, SwapPairError};
use swap_pair::events::SwapEvent;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;

const ERC20: (&str, &str) = ("ERC20", "0.1.5");
const ERC20_METADATA: (&str, &str) = ("ERC20Metadata", "0.1.5");
const FACTORY: (&str, &str) = ("SwapFactory", "0.1.0");
const ROUTER: (&str, &str) = ("SwapRouter", "0.1.0");
const PAIR: (&str, &str) = ("SwapPair", "0.1.0");
const HANDLER: (&str, &str) = ("SwapHandler", "0.1.0");
const DRIVER: (&str, &str) = ("SwapDriver", "0.1.0");

const CONTRACT_FUNDING: Amount = 10_000_000;
const MINT_AMOUNT: Amount = 2_000_000_000;
const LIQUIDITY_AMOUNT: Amount = 1_000_000_000;
const SWAP_AMOUNTS: [Amount; 2] = [10_000, 20_000];
#[derive(Clone, Copy)]
struct Deployment {
    account_index: u32,
    wallet: ContractAddress,
    token_a: ContractAddress,
    token_b: ContractAddress,
    factory: ContractAddress,
    router: ContractAddress,
    pair: ContractAddress,
    liquidity_token: ContractAddress,
    handler: ContractAddress,
    driver: ContractAddress,
}

#[tokio::main]
async fn main() -> Result<()> {
    let rpc_url = env("GROUNDHOG_RPC_URL")?;
    let manifest_path = PathBuf::from(env("GROUNDHOG_RUNTIME_MANIFEST")?);
    let artifact_root = PathBuf::from(env("GROUNDHOG_TESTKIT_ARTIFACT_ROOT")?);
    let output_path = PathBuf::from(env("SWAP_APP_ENV")?);
    let groundhog_cli = PathBuf::from(env("GROUNDHOG_CLI")?);
    let deployment = Arc::new(Mutex::new(None));

    let scenario = Scenario::builder("swap-app-local-setup")
        .network(NetworkConfig::existing(&rpc_url, &manifest_path))
        .artifact("erc20", artifact_root.join("erc20.rv32a"))
        .artifact("swap_pair", artifact_root.join("swap_pair.wasm"))
        .artifact("swap_handler", artifact_root.join("swap_handler.rv32a"))
        .artifact("swap_driver", artifact_root.join("swap_driver.rv32a"))
        .artifact("swap_router", artifact_root.join("swap_router.rv32a"))
        .artifact("swap_factory", artifact_root.join("swap_factory.rv32a"))
        .build()
        .await?;

    let result = Arc::clone(&deployment);
    scenario
        .run_agents([Agent::new("setup", move |mut ctx| async move {
            *result.lock().expect("deployment lock poisoned") = Some(setup(&mut ctx).await);
            Ok(())
        })])
        .await?;
    scenario.stop().await?;

    let deployed = deployment
        .lock()
        .expect("deployment lock poisoned")
        .take()
        .ok_or("setup agent returned no result")??;
    write_env(&output_path, &rpc_url, &manifest_path, deployed)?;

    println!("Local swap environment is ready: {}", output_path.display());
    println!(
        "Crank: {} call {} process_requests --wallet dev-{} --rpc-url {} --runtime-manifest {}",
        shell_arg(&groundhog_cli.display().to_string()),
        address(deployed.driver),
        deployed.account_index,
        shell_arg(&rpc_url),
        shell_arg(&manifest_path.display().to_string()),
    );
    Ok(())
}

async fn setup(ctx: &mut AgentContext) -> Result<Deployment> {
    let wallet = ctx.address();
    let native = native_token();

    ctx.register_artifact("swap_pair").await?;
    ctx.register_artifact("swap_handler").await?;
    ctx.register_artifact("swap_driver").await?;

    let token_a = deploy_token(ctx, &native, "Groundhog USD", "gUSD", wallet).await?;
    let token_b = deploy_token(ctx, &native, "Groundhog EUR", "gEUR", wallet).await?;

    let factory = Contract::new(
        ctx.deploy_artifact("swap_factory").await?.address,
        FACTORY.0,
        FACTORY.1,
    );
    fund(ctx, &native, factory.address()).await?;
    let hashes = SwapHashes {
        token: ctx.contract_hash("erc20")?,
        pair: ctx.contract_hash("swap_pair")?,
        handler: ctx.contract_hash("swap_handler")?,
        driver: ctx.contract_hash("swap_driver")?,
    };
    factory
        .call(
            ctx,
            "initialize",
            &(hashes, Option::<ContractAddress>::None),
        )
        .await?;

    let router = Contract::new(
        ctx.deploy_artifact("swap_router").await?.address,
        ROUTER.0,
        ROUTER.1,
    );
    fund(ctx, &native, router.address()).await?;
    router.call(ctx, "initialize", &factory.address()).await?;

    let suite: Suite = factory
        .view(
            ctx,
            "predict_pair",
            &(token_a.address(), token_b.address()),
            None,
        )
        .await?;
    for target in [
        suite.liquidity_token,
        suite.pair,
        suite.handler,
        suite.driver,
    ] {
        fund(ctx, &native, target).await?;
    }

    let handler = Contract::new(suite.handler, HANDLER.0, HANDLER.1);
    let driver = Contract::new(suite.driver, DRIVER.0, DRIVER.1);
    let pair = Contract::new(suite.pair, PAIR.0, PAIR.1);
    let allowance = i128::try_from(MINT_AMOUNT).expect("mint amount fits i128");
    token_a
        .call(ctx, "adjust_allowance", &(handler.address(), allowance))
        .await?;
    token_b
        .call(ctx, "adjust_allowance", &(handler.address(), allowance))
        .await?;

    router
        .call(
            ctx,
            "add_liquidity",
            &(
                token_a.address(),
                token_b.address(),
                [LIQUIDITY_AMOUNT; 2],
                [0_u128; 2],
                wallet,
            ),
        )
        .await?;
    require_processed(&driver, ctx, 1).await?;
    verify_pool(ctx, &pair, &token_a, &token_b, LIQUIDITY_AMOUNT).await?;

    router
        .call(
            ctx,
            "swap_exact_tokens_for_tokens",
            &(
                SWAP_AMOUNTS[0],
                1_u128,
                token_a.address(),
                token_b.address(),
                wallet,
            ),
        )
        .await?;
    router
        .call(
            ctx,
            "swap_exact_tokens_for_tokens",
            &(
                SWAP_AMOUNTS[1],
                1_u128,
                token_b.address(),
                token_a.address(),
                wallet,
            ),
        )
        .await?;
    require_processed(&driver, ctx, 2).await?;
    verify_reserve_balances(ctx, &pair, &token_a, &token_b).await?;
    verify_swap_events(ctx, suite.pair, suite.handler, wallet).await?;
    verify_view_outcomes(ctx, &pair, wallet).await?;

    let token_a_balance: Amount = token_a.view(ctx, "get_balance_of", &wallet, None).await?;
    let token_b_balance: Amount = token_b.view(ctx, "get_balance_of", &wallet, None).await?;
    let allowance_a: Amount = token_a
        .view(ctx, "allowance", &(wallet, suite.handler), None)
        .await?;
    let allowance_b: Amount = token_b
        .view(ctx, "allowance", &(wallet, suite.handler), None)
        .await?;
    ensure(
        token_a_balance > 0 && token_b_balance > 0,
        format!("expected positive token balances, got {token_a_balance} and {token_b_balance}"),
    )?;
    ensure(
        allowance_a > 0 && allowance_b > 0,
        format!("expected positive handler allowances, got {allowance_a} and {allowance_b}"),
    )?;

    println!("token balances: {token_a_balance} gUSD, {token_b_balance} gEUR");
    Ok(Deployment {
        account_index: ctx.account_index(),
        wallet,
        token_a: token_a.address(),
        token_b: token_b.address(),
        factory: factory.address(),
        router: router.address(),
        pair: suite.pair,
        liquidity_token: suite.liquidity_token,
        handler: suite.handler,
        driver: suite.driver,
    })
}

async fn deploy_token(
    ctx: &mut AgentContext,
    native: &Contract,
    name: &str,
    symbol: &str,
    administrator: ContractAddress,
) -> Result<Contract> {
    let token = Contract::new(
        ctx.deploy_artifact("erc20").await?.address,
        ERC20.0,
        ERC20.1,
    );
    fund(ctx, native, token.address()).await?;
    let encoded_name = Name::try_from(name).expect("static token name fits metadata limit");
    let encoded_symbol = Symbol::try_from(symbol).expect("static token symbol fits metadata limit");
    let metadata = Contract::new(token.address(), ERC20_METADATA.0, ERC20_METADATA.1);
    metadata
        .call(
            ctx,
            "initialize",
            &(
                administrator,
                Some(encoded_name),
                Some(encoded_symbol),
                Some(6_u32),
            ),
        )
        .await?;
    let actual_name: Option<Name> = metadata.view(ctx, "name", &(), None).await?;
    let actual_symbol: Option<Symbol> = metadata.view(ctx, "symbol", &(), None).await?;
    let actual_decimals: Option<u32> = metadata.view(ctx, "decimals", &(), None).await?;
    ensure(
        actual_name.as_ref().map(Name::as_str) == Some(name),
        format!("token metadata name mismatch: expected {name}, got {actual_name:?}"),
    )?;
    ensure(
        actual_symbol.as_ref().map(Symbol::as_str) == Some(symbol),
        format!("token metadata symbol mismatch: expected {symbol}, got {actual_symbol:?}"),
    )?;
    ensure(
        actual_decimals == Some(6),
        format!("token metadata decimals mismatch: expected 6, got {actual_decimals:?}"),
    )?;
    token
        .call(ctx, "mint", &(administrator, MINT_AMOUNT))
        .await?;
    Ok(token)
}

async fn fund(ctx: &mut AgentContext, native: &Contract, target: ContractAddress) -> Result<()> {
    native
        .call(ctx, "transfer", &(target, CONTRACT_FUNDING))
        .await?;
    Ok(())
}

async fn require_processed(driver: &Contract, ctx: &mut AgentContext, expected: u32) -> Result<()> {
    let outcome: (u32, u32) = driver.call_returning(ctx, "process_requests", &()).await?;
    ensure(
        outcome == (expected, 0),
        format!(
            "request processing mismatch: expected ({expected}, 0), got ({}, {})",
            outcome.0, outcome.1
        ),
    )
}

async fn verify_pool(
    ctx: &AgentContext,
    pair: &Contract,
    token_a: &Contract,
    token_b: &Contract,
    expected: Amount,
) -> Result<()> {
    let (reserve_a, reserve_b, _): (Amount, Amount, u32) =
        pair.view(ctx, "get_reserves", &(), None).await?;
    ensure(
        (reserve_a, reserve_b) == (expected, expected),
        format!(
            "initial reserves mismatch: expected ({expected}, {expected}), got ({reserve_a}, {reserve_b})"
        ),
    )?;
    verify_reserve_balances(ctx, pair, token_a, token_b).await
}

async fn verify_reserve_balances(
    ctx: &AgentContext,
    pair: &Contract,
    token_a: &Contract,
    token_b: &Contract,
) -> Result<()> {
    let (reserve_a, reserve_b, _): (Amount, Amount, u32) =
        pair.view(ctx, "get_reserves", &(), None).await?;
    let (token_0, token_1) = if token_a.address() <= token_b.address() {
        (token_a, token_b)
    } else {
        (token_b, token_a)
    };
    let balance_0: Amount = token_0
        .view(ctx, "get_balance_of", &pair.address(), None)
        .await?;
    let balance_1: Amount = token_1
        .view(ctx, "get_balance_of", &pair.address(), None)
        .await?;
    ensure(
        (balance_0, balance_1) == (reserve_a, reserve_b),
        format!(
            "pair balances do not match reserves: balances=({balance_0}, {balance_1}), reserves=({reserve_a}, {reserve_b})"
        ),
    )
}

async fn verify_swap_events(
    ctx: &AgentContext,
    pair: ContractAddress,
    handler: ContractAddress,
    recipient: ContractAddress,
) -> Result<()> {
    let contracts = ContractAddressList(
        vec![pair.into()]
            .try_into()
            .expect("one contract fits filter"),
    );
    let signatures = TopicList(
        vec![Topic(*SwapEvent::SIGNATURE)]
            .try_into()
            .expect("one topic fits filter"),
    );
    let filters = EventFilterList(
        vec![EventFilter {
            contract_addresses: contracts,
            topics: EventTopicFilter {
                topic0: signatures,
                topic1: TopicList::default(),
                topic2: TopicList::default(),
            },
        }]
        .try_into()
        .expect("one event filter fits query"),
    );
    let mut cursor = PaginationCursor::default();
    let mut ids = Vec::new();
    loop {
        let page = ctx
            .network()
            .get_events(EventQuery {
                filters: filters.clone(),
                order: IterationOrder::Ascending,
                anchor: BlockAnchor::AtBeginning,
                cursor,
                limit: 1,
            })
            .await?;
        for event in page.events {
            ensure(
                event.event.topics.len() == 3,
                format!(
                    "SwapEvent at block {} has {} topics, expected 3",
                    *event.block_height,
                    event.event.topics.len()
                ),
            )?;
            ensure(
                event.event.topics[1].0.as_slice() == handler.as_ref(),
                "SwapEvent sender topic is not the request handler",
            )?;
            ensure(
                event.event.topics[2].0.as_slice() == recipient.as_ref(),
                "SwapEvent recipient topic is not the setup wallet",
            )?;
            let payload = SwapEvent::decode_payload(&event.event.data.0)?;
            ensure(
                payload.amounts_in.iter().any(|amount| *amount > 0)
                    && payload.amounts_out.iter().any(|amount| *amount > 0),
                "SwapEvent payload does not contain positive input and output amounts",
            )?;
            let id = (event.block_height, event.tx_hash, event.sequence_number);
            ensure(
                !ids.contains(&id),
                "event pagination returned a duplicate event ID",
            )?;
            ids.push(id);
        }
        cursor = page.cursor;
        if cursor.0.is_empty() {
            break;
        }
    }
    ensure(
        ids.len() == SWAP_AMOUNTS.len(),
        format!(
            "expected {} SwapEvents, found {}",
            SWAP_AMOUNTS.len(),
            ids.len()
        ),
    )?;
    for events in ids.windows(2) {
        let previous = &events[0];
        let current = &events[1];
        ensure(
            previous.0 < current.0
                || (previous.0 == current.0 && previous.1 == current.1 && previous.2 < current.2),
            "SwapEvent pages were not returned in ascending order",
        )?;
    }
    Ok(())
}

async fn verify_view_outcomes(
    ctx: &AgentContext,
    pair: &Contract,
    caller: ContractAddress,
) -> Result<()> {
    let swap_entrypoint = entrypoint_id(PAIR.0, PAIR.1, "swap");
    let abort = ctx
        .network()
        .view_call(
            pair.address(),
            swap_entrypoint,
            &xdrs::cxs::encode(&(0_u128, 0_u128, caller))?,
            Some(caller),
        )
        .await?;
    let RootInvocationOutput::Abort { abort_data } = abort.output else {
        return Err(format!(
            "expected zero-output swap view to abort, got {:?}",
            abort.output
        )
        .into());
    };
    let error: SwapPairError = xdrs::cxs::decode(&abort_data.0)?;
    ensure(
        matches!(error, SwapPairError::InsufficientOutputAmount),
        format!("expected InsufficientOutputAmount abort, got {error:?}"),
    )?;

    let fault = ctx
        .network()
        .view_call(ContractAddress::zero(), swap_entrypoint, &[], Some(caller))
        .await?;
    ensure(
        matches!(fault.output, RootInvocationOutput::Fault),
        format!(
            "expected invalid-target view to fault, got {:?}",
            fault.output
        ),
    )
}

fn native_token() -> Contract {
    let mut bytes = [0_u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), "ERC20", "0.1.3")
}

fn write_env(
    path: &Path,
    rpc_url: &str,
    manifest_path: &Path,
    deployment: Deployment,
) -> Result<()> {
    let bytes = std::fs::read(manifest_path)?;
    let manifest = parse_runtime_manifest(&bytes)?;
    let account = manifest
        .bootstrap_accounts
        .iter()
        .find(|account| account.index == deployment.account_index)
        .ok_or_else(|| {
            format!(
                "runtime manifest has no bootstrap account dev-{}",
                deployment.account_index
            )
        })?;
    ensure(
        account.wallet_address.0 == deployment.wallet,
        format!(
            "runtime manifest dev-{} wallet does not match the testkit-assigned wallet",
            deployment.account_index
        ),
    )?;
    let private_key = hex::encode(derive_dev_account_secret(
        &manifest.bootstrap_account_derivation.seed,
        usize::try_from(deployment.account_index)?,
    ));

    let contents = format!(
        "VITE_GROUNDHOG_RPC_URL={rpc_url}\n\
         VITE_GROUNDHOG_NETWORK_ID={}\n\
         VITE_GROUNDHOG_DEV_PRIVATE_KEY=0x{private_key}\n\
         VITE_GROUNDHOG_WALLET_ADDRESS={}\n\
         VITE_GROUNDHOG_WALLET_ENTRYPOINT={}\n\
         VITE_SWAP_FACTORY_ADDRESS={}\n\
         VITE_SWAP_ROUTER_ADDRESS={}\n\
         VITE_SWAP_PAIR_ADDRESS={}\n\
         VITE_SWAP_LP_TOKEN_ADDRESS={}\n\
         VITE_SWAP_HANDLER_ADDRESS={}\n\
         VITE_SWAP_DRIVER_ADDRESS={}\n\
         VITE_TOKEN_A_ADDRESS={}\n\
         VITE_TOKEN_B_ADDRESS={}\n\
         VITE_TOKEN_A_SYMBOL=gUSD\n\
         VITE_TOKEN_B_SYMBOL=gEUR\n\
         VITE_TOKEN_DECIMALS=6\n",
        manifest.network_hash,
        address(deployment.wallet),
        manifest.bootstrap.dev_wallet.do_action_entrypoint,
        address(deployment.factory),
        address(deployment.router),
        address(deployment.pair),
        address(deployment.liquidity_token),
        address(deployment.handler),
        address(deployment.driver),
        address(deployment.token_a),
        address(deployment.token_b),
    );
    std::fs::write(path, contents)?;
    Ok(())
}

fn address(value: ContractAddress) -> String {
    format!("0x{}", hex::encode(value.as_ref()))
}

fn ensure(condition: bool, detail: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(detail.into().into())
    }
}

fn shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| format!("{name} must be set").into())
}
