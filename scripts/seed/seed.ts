import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  addressFromBase58,
  bytesEqual,
  createThruputClient,
  createPubkeyAccount,
  fixedBytes,
  fromHex0x,
  hashContract,
  hashFromBase58,
  isThruputError,
  defineCluster,
  parseAddress,
  Ed25519Signer,
  toBase58,
  toHex0x,
  type ContractCall,
} from "@thruputchain/client";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  networkHash,
  type Contract,
  type ContractAddress,
} from "@thruputchain/protocol";
import { withScenario } from "@thruputchain/testkit";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory.ts";
import {
  ERC20,
  ERC20Metadata,
} from "../../apps/token-launchpad/src/contracts/generated/standard-token.ts";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory.ts";
import { SwapRouter } from "../../apps/swap/src/contracts/generated/swap-router.ts";
import {
  SwapDriver,
  batch_driver,
} from "../../apps/swap/src/contracts/generated/swap-driver.ts";
import { SwapHandler } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { validateLocalRpcUrl } from "./local-rpc.ts";
import {
  seedTransport,
  verifySwapRelationship,
  SeedError,
} from "./seed-preflight.ts";
import { assertLiquidityMint } from "./seed-liquidity.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GAS = gasAmount(10_000_000n);
const SUPPLY = 1_000_000n * 1_000_000n;
const LIQUIDITY = 1_000n * 1_000_000n;
const RESERVE = 10_000_000n;

async function artifact(directory: string, hash: string): Promise<Contract> {
  const value = JSON.parse(
    await readFile(
      join(resolve(ROOT, directory), "contract-artifacts", `${hash}.json`),
      "utf8",
    ),
  );
  const contract: Contract = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: fromHex0x(value.data) },
  };
  if (
    value.contractType !== "rv32" ||
    value.hash !== hash ||
    toBase58(hashContract(contract)) !== hash
  )
    throw new SeedError("Setup artifact hash mismatch");
  return contract;
}

/** Fresh local demo assets. No saved keys, journal, resume, or write retries. */
export async function seed(
  phase: "tokens" | "pools",
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  async function environment(path: string) {
    const file = parseEnv(await readFile(resolve(ROOT, path), "utf8"));
    for (const key of Object.keys(file)) file[key] = env[key] ?? file[key]!;
    return file;
  }
  let step = "validate recipient and local setup";
  try {
    if (!env.SEED_RECIPIENT)
      throw new SeedError(
        "Set SEED_RECIPIENT to the recipient account's public address",
      );
    const recipient = parseAddress(env.SEED_RECIPIENT);
    if (recipient.every((byte) => byte === 0))
      throw new SeedError("SEED_RECIPIENT must not be the zero address");
    const launch = await environment(
      env.LAUNCHPAD_APP_ENV ?? "apps/token-launchpad/.env.local",
    );
    const swap =
      phase === "pools"
        ? await environment(env.SWAP_APP_ENV ?? "apps/swap/.env.local")
        : undefined;
    const rpcUrl = validateLocalRpcUrl(
      env.THRUPUT_RPC_URL ?? launch.VITE_THRUPUT_RPC_URL!,
    );
    const cluster = defineCluster({
      name: "local",
      rpcUrl,
      capabilities: ["airdrop"] as const,
    });
    const transport = seedTransport(rpcUrl);
    const client = await createThruputClient({ cluster, transport });
    const network = toBase58(client.network.networkHash);
    for (const config of [launch, ...(swap ? [swap] : [])]) {
      if (
        toBase58(hashFromBase58(config.VITE_THRUPUT_NETWORK_ID!)) !== network ||
        (!env.THRUPUT_RPC_URL &&
          validateLocalRpcUrl(config.VITE_THRUPUT_RPC_URL!) !== rpcUrl)
      )
        throw new SeedError(
          "App network or RPC endpoint does not match this local node",
        );
    }
    const factory = addressFromBase58(
      launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
    );
    const tokenHash = toBase58(
      hashFromBase58(launch.VITE_STANDARD_TOKEN_HASH!),
    );
    const config = (
      await StandardTokenFactory.v0_1.config.view({ client, address: factory })
    ).value;
    if (
      toBase58(config.token_code_hash) !== tokenHash ||
      !bytesEqual(config.native_token, NATIVE_TOKEN_ADDRESS) ||
      config.creation_fee !== 0n ||
      config.fee_recipient !== null ||
      config.required_token_funding <= 0n
    )
      throw new SeedError("Unsupported launchpad factory configuration");
    const tokenCode = await artifact(
      env.LAUNCHPAD_APP_PUBLIC_DIR ?? "apps/token-launchpad/public",
      tokenHash,
    );
    const poolConfig = swap
      ? {
          factory: addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!),
          router: addressFromBase58(swap.VITE_SWAP_ROUTER_ADDRESS!),
          code: await artifact(
            env.SWAP_APP_PUBLIC_DIR ?? "apps/swap/public",
            toBase58(hashFromBase58(swap.VITE_POOL_TOKEN_HASH!)),
          ),
          funding: (
            await SwapFactory.v0_1.poolFunding.view({
              client,
              address: addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!),
            })
          ).value,
        }
      : undefined;
    if (poolConfig) {
      if (
        poolConfig.funding.min <= 0n ||
        poolConfig.funding.recommended < poolConfig.funding.min
      )
        throw new SeedError("Invalid pool funding policy");
      await verifySwapRelationship(
        client,
        poolConfig.factory,
        poolConfig.router,
      );
    }

    // A fresh in-memory signer. Testkit keeps its report in memory only: the
    // seed saves no key or journal, and a new run creates new assets.
    const account = createPubkeyAccount({
      signer: Ed25519Signer.fromSeed(randomBytes(32)),
    });
    console.log(
      `Fresh ${phase} seed. Recipient: ${toBase58(recipient)}. Tool account: ${toBase58(account.address)}`,
    );
    const { tokens, pool } = await withScenario(
      {
        network: {
          cluster: {
            ...cluster,
            // The app's configured network, checked against this node above.
            networkHash: networkHash(
              hashFromBase58(launch.VITE_THRUPUT_NETWORK_ID!),
            ),
          },
          transport,
        },
        accounts: { seed: account },
        // Awaited before broadcast, so the hash is printed even if the response is lost.
        onSigned: (_, evidence) => {
          console.log(
            `Submitting ${step}: ${toBase58(evidence.transactionHash)}`,
          );
        },
      },
      async (scenario) => {
        const actor = scenario.actor("seed");
        async function fundAccount() {
          step = "fund seed account";
          // Two token deployments, optional pool storage, and a scheduling reserve.
          const minimum =
            2n * (config.required_token_funding + RESERVE) +
            (poolConfig?.funding.recommended ?? 0n) * 3n +
            RESERVE * 10n;
          let balance = (await actor.wallet.getBalance()).rawBalance;
          while (balance < minimum) {
            const funding = await actor.fund({ timeoutMs: 60_000 });
            console.log(`Airdrop: ${toBase58(funding.transactionHash)}`);
            const next = (await actor.wallet.getBalance()).rawBalance;
            if (next <= balance)
              throw new SeedError(
                "Confirmed native funding is not visible. Inspect the original request before continuing.",
              );
            balance = next;
          }
        }
        async function execute(
          name: string,
          call: ContractCall,
          contractsToDeploy: Contract[] = [],
        ) {
          step = name;
          const { receipt, transactionHash } = await actor.call([call], {
            contractsToDeploy,
            wait: { timeoutMs: 60_000 },
          });
          console.log(`Completed ${name}: ${toBase58(transactionHash)}`);
          return receipt;
        }
        // Testkit reads state that includes every confirmed seed transaction.
        const balance = async (
          token: ContractAddress,
          owner: ContractAddress,
        ) =>
          (
            await scenario.view(
              ERC20.v0_1.getBalanceOf.viewRequest({
                address: token,
                args: { addr: owner },
              }),
            )
          ).value;

        async function createTokens() {
          const tokens: ContractAddress[] = [];
          for (const [name, symbol] of [
            ["Thruput Demo Dollar", "gUSD"],
            ["Thruput Demo Euro", "gEUR"],
          ] as const) {
            const nonce = fixedBytes(randomBytes(32), 32);
            const address = (
              await scenario.view(
                StandardTokenFactory.v0_1.predictToken.viewRequest({
                  address: factory,
                  args: { creator: account.address, nonce },
                }),
              )
            ).value;
            await execute(
              `fund-${symbol}`,
              ERC20.v0_1.transfer.call({
                address: NATIVE_TOKEN_ADDRESS,
                gasLimit: GAS,
                args: {
                  receiver: address,
                  amount: config.required_token_funding + RESERVE,
                },
              }),
            );
            const holder = poolConfig ? account.address : recipient;
            const receipt = await execute(
              `create-${symbol}`,
              StandardTokenFactory.v0_1.createToken.call({
                address: factory,
                gasLimit: GAS,
                args: {
                  nonce,
                  administrator: recipient,
                  initialHolder: holder,
                  initialSupply: SUPPLY,
                  name,
                  symbol,
                  decimals: 6n,
                },
              }),
              [tokenCode],
            );
            const created =
              standard_token_factory_if.v0_1.events.TokenCreated.singleFromReceipt(
                receipt,
                { address: factory },
              );
            if (
              !bytesEqual(created.topics.token, address) ||
              !bytesEqual(created.topics.creator, account.address) ||
              !bytesEqual(created.fields.administrator, recipient) ||
              !bytesEqual(created.fields.initial_holder, holder) ||
              created.fields.initial_supply !== SUPPLY
            )
              throw new SeedError("Token creation evidence mismatch");
            if (
              (
                await scenario.view(
                  ERC20Metadata.v0_1.symbol.viewRequest({ address }),
                )
              ).value !== symbol ||
              (
                await scenario.view(
                  ERC20.v0_1.totalSupply.viewRequest({ address }),
                )
              ).value !== SUPPLY ||
              (await balance(address, holder)) !== SUPPLY
            )
              throw new SeedError("Token state mismatch");
            tokens.push(address);
            console.log(`${symbol}: ${toBase58(address)}`);
          }
          return tokens;
        }
        async function createPool(tokens: ContractAddress[]) {
          if (!poolConfig) return;
          const [tokenA, tokenB] = tokens as [ContractAddress, ContractAddress];
          await execute(
            "approve-pool-funding",
            ERC20.v0_1.adjustAllowance.call({
              address: NATIVE_TOKEN_ADDRESS,
              gasLimit: GAS,
              args: {
                spender: poolConfig.factory,
                difference: poolConfig.funding.recommended * 3n,
              },
            }),
          );
          await execute(
            "create-pair",
            SwapFactory.v0_1.createPair.call({
              address: poolConfig.factory,
              gasLimit: GAS,
              args: { tokenA, tokenB, funding: poolConfig.funding.recommended },
            }),
            [poolConfig.code],
          );
          const pairArgs = {
            address: poolConfig.factory,
            args: { tokenA, tokenB },
          };
          const pool = (
            await scenario.view(
              SwapFactory.v0_1.poolAddresses.viewRequest(pairArgs),
            )
          ).value;
          const pair = (
            await scenario.view(SwapFactory.v0_1.getPair.viewRequest(pairArgs))
          ).value;
          if (!pair || !bytesEqual(pair, pool.handler))
            throw new SeedError("Created pool address mismatch");
          for (const token of tokens)
            await execute(
              "approve-liquidity",
              ERC20.v0_1.adjustAllowance.call({
                address: token,
                gasLimit: GAS,
                args: { spender: pool.handler, difference: LIQUIDITY },
              }),
            );
          const queued = await execute(
            "add-liquidity",
            SwapRouter.v0_1.addLiquidity.call({
              address: poolConfig.router,
              gasLimit: GAS,
              args: {
                tokenA,
                tokenB,
                amountsDesired: [LIQUIDITY, LIQUIDITY],
                amountsMin: [LIQUIDITY, LIQUIDITY],
                recipient,
              },
            }),
          );
          const accepted =
            batch_driver.v0_1.events.RequestAccepted.singleFromReceipt(queued, {
              address: pool.driver,
            });
          console.log(
            `Liquidity request: ${toHex0x(accepted.topics.request_id)}`,
          );
          const receipt = await execute(
            "process-liquidity",
            SwapDriver.v0_1.processRequests.call({
              address: pool.driver,
              gasLimit: GAS,
            }),
          );
          assertLiquidityMint(
            receipt,
            pool.handler,
            accepted.topics.request_id,
            account.address,
            recipient,
          );
          const state = (
            await scenario.view(
              SwapHandler.v0_1.poolState.viewRequest({ address: pool.handler }),
            )
          ).value;
          if (
            state.reserves.some((reserve) => reserve !== LIQUIDITY) ||
            (await balance(pool.liquidity_token, recipient)) <= 0n
          )
            throw new SeedError("Pool reserves or LP balance mismatch");
          return pool;
        }
        async function distributeTokens(tokens: ContractAddress[]) {
          for (const token of tokens)
            await execute(
              "distribute-tokens",
              ERC20.v0_1.transfer.call({
                address: token,
                gasLimit: GAS,
                args: { receiver: recipient, amount: SUPPLY - LIQUIDITY },
              }),
            );
          for (const token of tokens)
            if ((await balance(token, recipient)) !== SUPPLY - LIQUIDITY)
              throw new SeedError("Recipient token balance mismatch");
        }
        await fundAccount();
        const tokens = await createTokens();
        const pool = await createPool(tokens);
        if (pool) await distributeTokens(tokens);
        return { tokens, pool };
      },
    );
    console.log(
      `Seed result: ${JSON.stringify({
        recipient: toBase58(recipient),
        tokens: tokens.map(toBase58),
        ...(pool
          ? {
              pool: {
                handler: toBase58(pool.handler),
                liquidityToken: toBase58(pool.liquidity_token),
              },
            }
          : {}),
      })}`,
    );
  } catch (error) {
    console.error(
      `Fresh seed stopped at ${step}. Completed steps and transaction hashes are printed above.`,
    );
    // RPC errors can contain signed payloads; only print our own validation errors.
    if (error instanceof SeedError) console.error(error.message);
    // A stopped transaction, including a faucet request, names its hash.
    if (isThruputError(error) && error.transaction)
      console.error(
        `Inspect transaction ${toBase58(error.transaction.hash)} before continuing.`,
      );
    console.error(
      "No writes will be retried. A new run creates new assets; use a fresh node to start over.",
    );
    throw error;
  }
}
