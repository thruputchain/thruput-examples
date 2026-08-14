use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use groundhog_erc20_if::Amount;
use groundhog_erc20_metadata_if::{Name, Symbol};
use groundhog_json_rpc_types::events::{
    BlockAnchor, ContractAddressList, EventFilter, EventFilterList, EventQuery, EventTopicFilter,
    IterationOrder, PaginationCursor, TopicList,
};
use groundhog_json_rpc_types::hex::Topic;
use groundhog_json_rpc_types::runtime_manifest::{
    HOGD_DEV_RUNTIME_MANIFEST_KIND, RuntimeManifest, RuntimeManifestChainState,
    parse_runtime_manifest,
};
use groundhog_json_rpc_types::view::RootInvocationOutput;
use groundhog_signing::dev_account::derive_dev_account_secret;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, NetworkConfig, Scenario, entrypoint_id, xdrs,
};
use sdk::Event;
use sdk::exn::RawException;
use swap_if::{Pool, RequestId, SwapHashes, SwapPairError};
use swap_pair::events::SwapEvent;
use url::Url;

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
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    token_a_balance: Amount,
    token_b_balance: Amount,
    reserve_a: Amount,
    reserve_b: Amount,
    token_a_to_b_output: Amount,
    token_b_to_a_output: Amount,
}

#[tokio::main]
async fn main() -> Result<()> {
    let output_path = PathBuf::from(env("SWAP_APP_ENV")?);
    let cli_config_home = PathBuf::from(env("SWAP_CLI_CONFIG_HOME")?);
    let cli_config_path = cli_config_home.join("groundhog/config.toml");
    let rpc_url = env("GROUNDHOG_RPC_URL")?;
    validate_loopback_rpc_url(&rpc_url)?;
    let manifest_path = PathBuf::from(env("GROUNDHOG_RUNTIME_MANIFEST")?);
    let manifest_bytes = std::fs::read(&manifest_path)?;
    let manifest = parse_runtime_manifest(&manifest_bytes)?;
    validate_runtime_manifest(&manifest)?;
    let artifact_root = PathBuf::from(env("GROUNDHOG_TESTKIT_ARTIFACT_ROOT")?);
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
    let tip = scenario.network().chain_tip().await?;
    ensure(
        *tip.height == 1,
        format!(
            "setup requires a fresh ledger at height 1; current chain tip is {}",
            *tip.height
        ),
    )?;
    invalidate_generated_outputs(&output_path, &cli_config_path)?;
    eprintln!(
        "Previous generated configuration is invalidated. If setup fails after deployment starts, reset the disposable ledger before retrying."
    );

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
    ensure(
        std::fs::read(&manifest_path)? == manifest_bytes,
        "runtime manifest changed during setup; reset the disposable ledger before retrying",
    )?;
    let app_env = render_env(&manifest, &rpc_url, deployed)?;
    let cli_config = render_cli_config(&manifest, &rpc_url, &manifest_path, deployed.account_index);
    publish_outputs(&output_path, &app_env, &cli_config_path, &cli_config)?;

    let app_dir = output_path
        .parent()
        .ok_or("SWAP_APP_ENV must have a parent directory")?;
    let crank_command = format!(
        "cd {} && GROUNDHOG_CLI={} bash scripts/crank-local.sh",
        shell_arg(&app_dir.display().to_string()),
        shell_arg(&groundhog_cli.display().to_string()),
    );
    println!(
        "{}",
        render_summary(&output_path, &cli_config_path, deployed, &crank_command)
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

    let pool: Pool = factory
        .view(
            ctx,
            "pool_addresses",
            &(token_a.address(), token_b.address()),
            None,
        )
        .await?;
    for target in [pool.liquidity_token, pool.pair, pool.handler, pool.driver] {
        fund(ctx, &native, target).await?;
    }

    let handler = Contract::new(pool.handler, HANDLER.0, HANDLER.1);
    let driver = Contract::new(pool.driver, DRIVER.0, DRIVER.1);
    let pair = Contract::new(pool.pair, PAIR.0, PAIR.1);
    let token_a_allowance = i128::try_from(LIQUIDITY_AMOUNT + SWAP_AMOUNTS[0])?;
    let token_b_allowance = i128::try_from(LIQUIDITY_AMOUNT + SWAP_AMOUNTS[1])?;
    token_a
        .call(
            ctx,
            "adjust_allowance",
            &(handler.address(), token_a_allowance),
        )
        .await?;
    token_b
        .call(
            ctx,
            "adjust_allowance",
            &(handler.address(), token_b_allowance),
        )
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
    verify_swap_events(
        ctx,
        pool.pair,
        pool.handler,
        wallet,
        token_a.address(),
        token_b.address(),
    )
    .await?;
    verify_view_outcomes(ctx, &pair, wallet).await?;

    let (reserve_0, reserve_1, _): (Amount, Amount, u32) =
        pair.view(ctx, "get_reserves", &(), None).await?;
    let (reserve_a, reserve_b) = if token_a.address() <= token_b.address() {
        (reserve_0, reserve_1)
    } else {
        (reserve_1, reserve_0)
    };
    let expected = expected_swaps(token_a.address(), token_b.address());
    let a_index = usize::from(token_a.address() > token_b.address());
    let b_index = 1 - a_index;
    let token_a_to_b_output = expected[0].1[b_index];
    let token_b_to_a_output = expected[1].1[a_index];

    let token_a_balance: Amount = token_a.view(ctx, "get_balance_of", &wallet, None).await?;
    let token_b_balance: Amount = token_b.view(ctx, "get_balance_of", &wallet, None).await?;
    let allowance_a: Amount = token_a
        .view(ctx, "allowance", &(wallet, pool.handler), None)
        .await?;
    let allowance_b: Amount = token_b
        .view(ctx, "allowance", &(wallet, pool.handler), None)
        .await?;
    ensure(
        token_a_balance > 0 && token_b_balance > 0,
        format!("expected positive token balances, got {token_a_balance} and {token_b_balance}"),
    )?;
    ensure(
        allowance_a == 0 && allowance_b == 0,
        format!("expected exhausted handler allowances, got {allowance_a} and {allowance_b}"),
    )?;

    Ok(Deployment {
        account_index: ctx.account_index(),
        wallet,
        token_a: token_a.address(),
        token_b: token_b.address(),
        factory: factory.address(),
        router: router.address(),
        pair: pool.pair,
        liquidity_token: pool.liquidity_token,
        handler: pool.handler,
        driver: pool.driver,
        token_a_balance,
        token_b_balance,
        reserve_a,
        reserve_b,
        token_a_to_b_output,
        token_b_to_a_output,
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
    let encoded_name = Name::try_from(name)?;
    let encoded_symbol = Symbol::try_from(symbol)?;
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
    token_a: ContractAddress,
    token_b: ContractAddress,
) -> Result<()> {
    let contracts = ContractAddressList(vec![pair.into()].try_into()?);
    let signatures = TopicList(vec![Topic(*SwapEvent::SIGNATURE)].try_into()?);
    let filters = EventFilterList(
        vec![EventFilter {
            contract_addresses: contracts,
            topics: EventTopicFilter {
                topic0: signatures,
                topic1: TopicList::default(),
                topic2: TopicList::default(),
            },
        }]
        .try_into()?,
    );
    let mut cursor = PaginationCursor::default();
    let mut ids = Vec::new();
    let expected = expected_swaps(token_a, token_b);
    let mut payloads = Vec::new();
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
                payload.request_id.is_some(),
                "processed SwapEvent is missing its request ID",
            )?;
            payloads.push((payload.amounts_in, payload.amounts_out));
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
        payloads == expected,
        format!("SwapEvent payload mismatch: expected {expected:?}, got {payloads:?}"),
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

fn expected_swaps(
    token_a: ContractAddress,
    token_b: ContractAddress,
) -> Vec<([Amount; 2], [Amount; 2])> {
    let a_index = usize::from(token_a > token_b);
    let b_index = 1 - a_index;
    let mut reserves = [LIQUIDITY_AMOUNT; 2];
    let mut expected = Vec::with_capacity(SWAP_AMOUNTS.len());

    for (amount_in, input_index) in [(SWAP_AMOUNTS[0], a_index), (SWAP_AMOUNTS[1], b_index)] {
        let output_index = 1 - input_index;
        let amount_in_with_fee = amount_in * 997;
        let amount_out = amount_in_with_fee * reserves[output_index]
            / (reserves[input_index] * 1_000 + amount_in_with_fee);
        let mut amounts_in = [0; 2];
        let mut amounts_out = [0; 2];
        amounts_in[input_index] = amount_in;
        amounts_out[output_index] = amount_out;
        reserves[input_index] += amount_in;
        reserves[output_index] -= amount_out;
        expected.push((amounts_in, amounts_out));
    }

    expected
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
            &xdrs::cxs::encode(&(0_u128, 0_u128, caller, Option::<RequestId>::None))?,
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
    let error = RawException::from_abort_buf(&abort_data.0)
        .map_err(|error| format!("failed to parse abort payload: {error:?}"))?
        .try_as::<SwapPairError>()
        .ok_or("abort payload is not a SwapPairError")?;
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

fn validate_loopback_rpc_url(value: &str) -> Result<()> {
    let url =
        Url::parse(value).map_err(|error| format!("GROUNDHOG_RPC_URL is invalid: {error}"))?;
    ensure(
        matches!(url.scheme(), "http" | "https"),
        "GROUNDHOG_RPC_URL must use http or https",
    )?;
    ensure(
        url.username().is_empty() && url.password().is_none(),
        "GROUNDHOG_RPC_URL must not contain credentials",
    )?;
    ensure(
        matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        ),
        "GROUNDHOG_RPC_URL must use the literal host localhost, 127.0.0.1, or ::1",
    )
}

fn validate_runtime_manifest(manifest: &RuntimeManifest) -> Result<()> {
    ensure(
        manifest.kind == HOGD_DEV_RUNTIME_MANIFEST_KIND,
        format!(
            "runtime manifest kind must be {HOGD_DEV_RUNTIME_MANIFEST_KIND:?}, got {:?}",
            manifest.kind
        ),
    )?;
    ensure(
        manifest.chain_state == Some(RuntimeManifestChainState::Fresh),
        format!(
            "runtime manifest must describe a fresh dev ledger, got chain state {:?}",
            manifest.chain_state
        ),
    )
}

fn render_env(manifest: &RuntimeManifest, rpc_url: &str, deployment: Deployment) -> Result<String> {
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
    let process_requests = entrypoint_id(DRIVER.0, DRIVER.1, "process_requests");

    Ok(format!(
        "VITE_GROUNDHOG_RPC_URL={rpc_url}\n\
         VITE_GROUNDHOG_NETWORK_ID={}\n\
         GROUNDHOG_DEV_PRIVATE_KEY=0x{private_key}\n\
         VITE_GROUNDHOG_WALLET_ADDRESS={}\n\
         VITE_GROUNDHOG_WALLET_ENTRYPOINT={}\n\
         VITE_SWAP_FACTORY_ADDRESS={}\n\
         VITE_SWAP_ROUTER_ADDRESS={}\n\
         VITE_SWAP_PAIR_ADDRESS={}\n\
         VITE_SWAP_LP_TOKEN_ADDRESS={}\n\
         VITE_SWAP_HANDLER_ADDRESS={}\n\
         VITE_SWAP_DRIVER_ADDRESS={}\n\
         SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT={}\n\
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
        entrypoint(process_requests),
        address(deployment.token_a),
        address(deployment.token_b),
    ))
}

fn render_cli_config(
    manifest: &RuntimeManifest,
    rpc_url: &str,
    manifest_path: &Path,
    account_index: u32,
) -> String {
    let network_id = &manifest.network_hash;
    format!(
        "# generated_network_id = {network_id}\n\
         default_key = \"dev-{account_index}\"\n\
         default_profile = \"local\"\n\
         \n\
         [profile.local]\n\
         network = \"local\"\n\
         rpc_url = {rpc_url:?}\n\
         runtime_manifest = {:?}\n",
        manifest_path.display().to_string(),
    )
}

fn invalidate_generated_outputs(app_env: &Path, cli_config: &Path) -> Result<()> {
    remove_file_if_present(app_env)?;
    remove_file_if_present(cli_config)?;
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to invalidate {}: {error}", path.display()).into()),
    }
}

fn publish_outputs(
    app_path: &Path,
    app_contents: &str,
    cli_path: &Path,
    cli_contents: &str,
) -> Result<()> {
    let app_file = PreparedFile::new(app_path, app_contents)?;
    let cli_file = PreparedFile::new(cli_path, cli_contents)?;

    if let Err(error) = cli_file.publish(cli_path) {
        let _ = remove_file_if_present(app_path);
        let _ = remove_file_if_present(cli_path);
        return Err(format!("failed to publish {}: {error}", cli_path.display()).into());
    }
    if let Err(error) = app_file.publish(app_path) {
        let _ = remove_file_if_present(app_path);
        let _ = remove_file_if_present(cli_path);
        return Err(format!("failed to publish {}: {error}", app_path.display()).into());
    }
    Ok(())
}

struct PreparedFile {
    path: Option<PathBuf>,
}

impl PreparedFile {
    fn new(destination: &Path, contents: &str) -> Result<Self> {
        let parent = destination
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", destination.display()))?;
        std::fs::create_dir_all(parent)?;
        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("{} has no valid file name", destination.display()))?;

        for _ in 0..100 {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".{file_name}.swap-setup-{}-{sequence}.tmp",
                std::process::id()
            ));
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path);
            let mut file = match file {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            };
            if let Err(error) = file
                .write_all(contents.as_bytes())
                .and_then(|()| file.sync_all())
            {
                let _ = std::fs::remove_file(&path);
                return Err(error.into());
            }
            return Ok(Self { path: Some(path) });
        }
        Err(format!(
            "could not create a temporary file for {}",
            destination.display()
        )
        .into())
    }

    fn publish(mut self, destination: &Path) -> std::io::Result<()> {
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| std::io::Error::other("prepared file was already published"))?;
        std::fs::rename(path, destination)?;
        self.path = None;
        Ok(())
    }
}

impl Drop for PreparedFile {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn address(value: ContractAddress) -> String {
    format!("0x{}", hex::encode(value.as_ref()))
}

fn entrypoint(value: groundhog_testkit::ContractEntrypointID) -> String {
    format!("0x{}", hex::encode(value.into_inner()))
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

fn render_summary(
    app_env: &Path,
    cli_config: &Path,
    deployment: Deployment,
    crank_command: &str,
) -> String {
    format!(
        "\n\
         ============================================================\n\
         Local swap setup complete\n\
         ============================================================\n\
         \n\
         Created\n\
           Tokens deployed: 2 (gUSD and gEUR)\n\
           Pools created:   1 (gUSD / gEUR)\n\
           Pair address:    {}\n\
         \n\
         Initial liquidity\n\
           {} gUSD\n\
           {} gEUR\n\
         \n\
         Verification swaps\n\
           1. {} gUSD -> {} gEUR\n\
           2. {} gEUR -> {} gUSD\n\
         \n\
         Final pool liquidity\n\
           {} gUSD\n\
           {} gEUR\n\
         \n\
         Final wallet balances\n\
           {} gUSD\n\
           {} gEUR\n\
         \n\
         Generated configuration\n\
           App: {}\n\
           CLI: {}\n\
         \n\
         Process future queued swaps with:\n\
           {}\n\
         ============================================================",
        address(deployment.pair),
        format_token_amount(LIQUIDITY_AMOUNT),
        format_token_amount(LIQUIDITY_AMOUNT),
        format_token_amount(SWAP_AMOUNTS[0]),
        format_token_amount(deployment.token_a_to_b_output),
        format_token_amount(SWAP_AMOUNTS[1]),
        format_token_amount(deployment.token_b_to_a_output),
        format_token_amount(deployment.reserve_a),
        format_token_amount(deployment.reserve_b),
        format_token_amount(deployment.token_a_balance),
        format_token_amount(deployment.token_b_balance),
        app_env.display(),
        cli_config.display(),
        crank_command,
    )
}

fn format_token_amount(value: Amount) -> String {
    const SCALE: Amount = 1_000_000;
    let whole = value / SCALE;
    let fraction = value % SCALE;
    format!("{}.{fraction:06}", group_digits(&whole.to_string()))
}

fn group_digits(value: &str) -> String {
    let mut grouped = String::with_capacity(value.len() + value.len() / 3);
    for (index, byte) in value.bytes().enumerate() {
        if index > 0 && (value.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(char::from(byte));
    }
    grouped
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| format!("{name} must be set").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn swap_event_payload_decodes_generated_cxs() {
        let bytes = hex::decode("0000007f1027007ff126000000").expect("valid fixture hex");

        let payload = SwapEvent::decode_payload(&bytes).expect("decode SwapEvent payload");

        assert_eq!(payload.amounts_in, [0, 10_000]);
        assert_eq!(payload.amounts_out, [9_969, 0]);
        assert_eq!(payload.request_id, None);
    }

    #[test]
    fn loopback_rpc_validation_accepts_policy_hosts() {
        for value in [
            "http://localhost:9545",
            "https://127.0.0.1:9545/",
            "http://[::1]:9545",
        ] {
            validate_loopback_rpc_url(value).expect("policy URL should be accepted");
        }
    }

    #[test]
    fn loopback_rpc_validation_rejects_credentials() {
        let error = validate_loopback_rpc_url("http://user:secret@127.0.0.1:9545")
            .expect_err("credentials should be rejected");

        assert!(error.to_string().contains("credentials"));
    }

    #[test]
    fn loopback_rpc_validation_rejects_nonliteral_or_remote_hosts() {
        for value in [
            "http://localhost.example:9545",
            "http://rpc.example.com:9545",
        ] {
            assert!(
                validate_loopback_rpc_url(value).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn render_cli_config_contains_coherent_network_and_endpoint() {
        let manifest = test_manifest();
        let rendered = render_cli_config(
            &manifest,
            "http://127.0.0.1:9545",
            Path::new("/tmp/runtime-manifest.json"),
            0,
        );

        assert!(rendered.contains("rpc_url = \"http://127.0.0.1:9545\""));
        assert!(rendered.contains("runtime_manifest = \"/tmp/runtime-manifest.json\""));
        assert!(rendered.contains(&format!("generated_network_id = {}", manifest.network_hash)));
    }

    #[test]
    fn render_env_derives_key_and_renders_deployment() {
        let manifest = test_manifest();
        let deployment = test_deployment();

        let rendered = render_env(&manifest, "http://127.0.0.1:9545", deployment)
            .expect("render app environment");

        assert!(rendered.contains("GROUNDHOG_DEV_PRIVATE_KEY=0x"));
        assert!(rendered.contains(&format!(
            "VITE_GROUNDHOG_WALLET_ADDRESS={}",
            address(deployment.wallet)
        )));
    }

    #[test]
    fn summary_explains_pool_setup_in_token_units() {
        let deployment = test_deployment();
        let summary = render_summary(
            Path::new("/tmp/.env.local"),
            Path::new("/tmp/config.toml"),
            deployment,
            "groundhog call driver process_requests",
        );

        assert!(summary.contains("Tokens deployed: 2 (gUSD and gEUR)"));
        assert!(summary.contains("Pools created:   1 (gUSD / gEUR)"));
        assert!(summary.contains("1,000.000000 gUSD"));
        assert!(summary.contains("1. 0.010000 gUSD -> 0.009969 gEUR"));
        assert!(summary.contains("2. 0.020000 gEUR -> 0.019940 gUSD"));
        assert!(summary.contains("999.990060 gUSD"));
        assert!(summary.contains("1,000.010031 gEUR"));
        assert!(summary.contains("1,000.009940 gUSD"));
        assert!(summary.contains("999.989969 gEUR"));
    }

    #[test]
    fn token_amount_formatting_uses_six_decimals_and_grouping() {
        assert_eq!(format_token_amount(0), "0.000000");
        assert_eq!(format_token_amount(9_969), "0.009969");
        assert_eq!(format_token_amount(1_000_000_000), "1,000.000000");
    }

    #[test]
    fn runtime_manifest_validation_rejects_recovered_ledger() {
        let mut manifest = test_manifest();
        manifest.chain_state = Some(RuntimeManifestChainState::Recovered);

        let error = validate_runtime_manifest(&manifest)
            .expect_err("recovered runtime manifest should be rejected");

        assert!(error.to_string().contains("fresh dev ledger"));
    }

    #[test]
    fn publish_outputs_atomically_replaces_symlink_with_private_files() {
        let directory = TestDirectory::new("publish-symlink");
        let app_path = directory.path().join(".env.local");
        let cli_path = directory.path().join("config/groundhog/config.toml");
        let symlink_target = directory.path().join("symlink-target");
        std::fs::write(&symlink_target, "do not replace").expect("write symlink target");
        std::os::unix::fs::symlink(&symlink_target, &app_path).expect("create destination symlink");

        publish_outputs(&app_path, "app", &cli_path, "cli").expect("publish outputs");

        assert_eq!(std::fs::read_to_string(&app_path).expect("read app"), "app");
        assert_eq!(std::fs::read_to_string(&cli_path).expect("read CLI"), "cli");
        assert_eq!(
            std::fs::read_to_string(&symlink_target).expect("read target"),
            "do not replace"
        );
        assert_eq!(
            std::fs::metadata(&app_path).expect("app metadata").mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&cli_path).expect("CLI metadata").mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn publish_outputs_removes_cli_config_when_app_publish_fails() {
        let directory = TestDirectory::new("publish-rollback");
        let app_path = directory.path().join(".env.local");
        let cli_path = directory.path().join("config.toml");
        std::fs::create_dir(&app_path).expect("create conflicting destination directory");

        let error = publish_outputs(&app_path, "app", &cli_path, "cli")
            .expect_err("app publication should fail");

        assert!(error.to_string().contains("failed to publish"));
        assert!(!cli_path.exists());
        assert!(app_path.is_dir());
    }

    fn test_manifest() -> RuntimeManifest {
        parse_runtime_manifest(
            br#"{
                "schemaVersion": 2,
                "kind": "hogd-dev-runtime",
                "chainState": "fresh",
                "networkHash": "4242424242424242424242424242424242424242424242424242424242424242",
                "protocol": "hogp/test",
                "genesisHash": "0x4242424242424242424242424242424242424242424242424242424242424242",
                "producer": { "binary": "hogd-dev", "version": "0.9.0" },
                "endpoints": { "scheduler": "127.0.0.1:1000" },
                "bootstrapAccountDerivation": {
                    "scheme": "groundhog-bootstrap-account-v1",
                    "seed": "groundhog-dev-accounts"
                },
                "bootstrapAccounts": [{
                    "index": 0,
                    "role": "local_user",
                    "publicKey": "0x6161616161616161616161616161616161616161616161616161616161616161",
                    "walletAddress": "0x7171717171717171717171717171717171717171717171717171717171717171",
                    "initialStorageTokens": "1000000000"
                }],
                "bootstrap": {
                    "devWallet": {
                        "contentHash": "0x5151515151515151515151515151515151515151515151515151515151515151",
                        "deployedCodeHash": "0x5252525252525252525252525252525252525252525252525252525252525252",
                        "artifactHint": "dev-wallet.wasm",
                        "deployEntrypoint": "0xadac498222148e4f",
                        "createWalletEntrypoint": "0x6372656174655761",
                        "doActionEntrypoint": "0x646f416374696f6e"
                    },
                    "storageCostModel": {
                        "hash": "0x5353535353535353535353535353535353535353535353535353535353535353",
                        "baseDataItemCost": "1",
                        "bytestringCostPerByte": "1",
                        "baseContractDeploymentCost": "1",
                        "contractDeploymentCostPerByte": "1",
                        "authPerKeyCost": "1",
                        "rcqCostPerEntry": "1",
                        "replayCacheCostPerEntry": "1",
                        "balanceCost": "1"
                    }
                }
            }"#,
        )
        .expect("test manifest should parse")
    }

    fn test_deployment() -> Deployment {
        Deployment {
            account_index: 0,
            wallet: ContractAddress::from([0x71; 32]),
            token_a: ContractAddress::from([0x01; 32]),
            token_b: ContractAddress::from([0x02; 32]),
            factory: ContractAddress::from([0x03; 32]),
            router: ContractAddress::from([0x04; 32]),
            pair: ContractAddress::from([0x05; 32]),
            liquidity_token: ContractAddress::from([0x06; 32]),
            handler: ContractAddress::from([0x07; 32]),
            driver: ContractAddress::from([0x08; 32]),
            token_a_balance: 1_000_009_940,
            token_b_balance: 999_989_969,
            reserve_a: 999_990_060,
            reserve_b: 1_000_010_031,
            token_a_to_b_output: 9_969,
            token_b_to_a_output: 19_940,
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "swap-setup-{name}-{}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir(&path).expect("create temporary test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).expect("remove temporary test directory");
        }
    }
}
