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
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  hashFromBase58,
  localnet,
  parseAddress,
  Ed25519Signer,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import {
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@thruputchain/protocol";
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
import { validateLocalRpcUrl } from "../../apps/token-launchpad/scripts/setup-local.ts";
import {
  seedTransport,
  verifySwapRelationship,
  SeedError,
  waitForView,
} from "./seed-preflight.ts";
import { submitSeedTransaction } from "./seed-transaction.ts";
import { assertLiquidityMint } from "./seed-liquidity.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GAS = gasAmount(10_000_000n);
const SUPPLY = 1_000_000n * 1_000_000n;
const LIQUIDITY = 1_000n * 1_000_000n;
const RESERVE = 10_000_000n;

async function environment(
  path: string,
): Promise<Record<string, string | undefined>> {
  const file = parseEnv(await readFile(resolve(ROOT, path), "utf8"));
  for (const key of Object.keys(file))
    file[key] = process.env[key] ?? file[key]!;
  return file;
}

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
export async function seed(phase: "tokens" | "pools"): Promise<void> {
  let step = "validate recipient and local setup";
  try {
    if (!process.env.SEED_RECIPIENT)
      throw new SeedError("Set SEED_RECIPIENT to your wallet's public address");
    const recipient = parseAddress(process.env.SEED_RECIPIENT);
    if (recipient.every((byte) => byte === 0))
      throw new SeedError("SEED_RECIPIENT must not be the zero address");
    const launch = await environment(
      process.env.LAUNCHPAD_APP_ENV ?? "apps/token-launchpad/.env.local",
    );
    const swap =
      phase === "pools"
        ? await environment(process.env.SWAP_APP_ENV ?? "apps/swap/.env.local")
        : undefined;
    const rpcUrl = validateLocalRpcUrl(
      process.env.THRUPUT_RPC_URL ?? launch.VITE_THRUPUT_RPC_URL!,
    );
    const client = await createThruputClient({
      cluster: localnet({ rpcUrl }),
      transport: seedTransport(rpcUrl),
    });
    const network = toBase58(client.network.networkHash);
    for (const config of [launch, ...(swap ? [swap] : [])]) {
      if (
        toBase58(hashFromBase58(config.VITE_THRUPUT_NETWORK_ID!)) !== network ||
        (!process.env.THRUPUT_RPC_URL &&
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
      !bytesEqual(config.native_token, HOG_ADDRESS) ||
      config.creation_fee !== 0n ||
      config.fee_recipient !== null ||
      config.required_token_funding <= 0n
    )
      throw new SeedError("Unsupported launchpad factory configuration");
    const tokenCode = await artifact(
      process.env.LAUNCHPAD_APP_PUBLIC_DIR ?? "apps/token-launchpad/public",
      tokenHash,
    );
    const poolConfig = swap
      ? {
          factory: addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!),
          router: addressFromBase58(swap.VITE_SWAP_ROUTER_ADDRESS!),
          code: await artifact(
            process.env.SWAP_APP_PUBLIC_DIR ?? "apps/swap/public",
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

    const account = createPubkeyAccount({
      signer: new Ed25519Signer(randomBytes(32)),
    });
    const wallet = createWalletClient({ client, account });
    console.log(
      `Fresh ${phase} seed. Recipient: ${toBase58(recipient)}. Tool account: ${toBase58(account.address)}`,
    );
    let height = 0n;
    async function execute(
      name: string,
      invocation: Invocation,
      contractsToDeploy: Contract[] = [],
    ) {
      step = name;
      if (
        (await wallet.getBalance()).rawBalance <
        RESERVE * 10n + (poolConfig?.funding.recommended ?? 0n) * 3n
      ) {
        const funding = await wallet.requestAirdrop();
        console.log(`Airdrop: ${toBase58(funding.transactionHash)}`);
      }
      const receipt = await submitSeedTransaction(wallet, name, {
        invocation,
        gasLimit: GAS,
        contractsToDeploy,
      });
      height = receipt.blockHeight;
      return receipt;
    }
    const balance = async (token: ContractAddress, owner: ContractAddress) =>
      (
        await waitForView(() =>
          ERC20.v0_1.getBalanceOf.view({
            client,
            address: token,
            args: { addr: owner },
            minStateBlockHeight: height,
          }),
        )
      ).value;

    const tokens = [];
    for (const [name, symbol] of [
      ["Thruput Demo Dollar", "gUSD"],
      ["Thruput Demo Euro", "gEUR"],
    ]) {
      const nonce = fixedBytes(randomBytes(32), 32);
      const address = (
        await StandardTokenFactory.v0_1.predictToken.view({
          client,
          address: factory,
          args: { creator: account.address, nonce },
        })
      ).value;
      await execute(
        `fund-${symbol}`,
        ERC20.v0_1.transfer.invocation(HOG_ADDRESS, GAS, {
          receiver: address,
          amount: config.required_token_funding + RESERVE,
        }),
      );
      const holder = poolConfig ? account.address : recipient;
      const receipt = await execute(
        `create-${symbol}`,
        StandardTokenFactory.v0_1.createToken.invocation(factory, GAS, {
          nonce,
          administrator: recipient,
          initialHolder: holder,
          initialSupply: SUPPLY,
          name: name!,
          symbol: symbol!,
          decimals: 6n,
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
      const options = { client, address, minStateBlockHeight: height };
      if (
        (await waitForView(() => ERC20Metadata.v0_1.symbol.view(options)))
          .value !== symbol ||
        (await waitForView(() => ERC20.v0_1.totalSupply.view(options)))
          .value !== SUPPLY ||
        (await balance(address, holder)) !== SUPPLY
      )
        throw new SeedError("Token state mismatch");
      tokens.push(address);
      console.log(`${symbol}: ${toBase58(address)}`);
    }
    const [tokenA, tokenB] = tokens as [ContractAddress, ContractAddress];
    let pool;
    if (poolConfig) {
      await execute(
        "approve-pool-funding",
        ERC20.v0_1.adjustAllowance.invocation(HOG_ADDRESS, GAS, {
          spender: poolConfig.factory,
          difference: poolConfig.funding.recommended * 3n,
        }),
      );
      await execute(
        "create-pair",
        SwapFactory.v0_1.createPair.invocation(poolConfig.factory, GAS, {
          tokenA,
          tokenB,
          funding: poolConfig.funding.recommended,
        }),
        [poolConfig.code],
      );
      const options = {
        client,
        address: poolConfig.factory,
        args: { tokenA, tokenB },
        minStateBlockHeight: height,
      };
      pool = (
        await waitForView(() => SwapFactory.v0_1.poolAddresses.view(options))
      ).value;
      const pair = (
        await waitForView(() => SwapFactory.v0_1.getPair.view(options))
      ).value;
      if (!pair || !bytesEqual(pair, pool.handler))
        throw new SeedError("Created pool address mismatch");
      for (const token of tokens)
        await execute(
          "approve-liquidity",
          ERC20.v0_1.adjustAllowance.invocation(token, GAS, {
            spender: pool.handler,
            difference: LIQUIDITY,
          }),
        );
      const queued = await execute(
        "add-liquidity",
        SwapRouter.v0_1.addLiquidity.invocation(poolConfig.router, GAS, {
          tokenA,
          tokenB,
          amountsDesired: [LIQUIDITY, LIQUIDITY],
          amountsMin: [LIQUIDITY, LIQUIDITY],
          recipient,
        }),
      );
      const accepted =
        batch_driver.v0_1.events.RequestAccepted.singleFromReceipt(queued, {
          address: pool.driver,
        });
      console.log(`Liquidity request: ${toHex0x(accepted.topics.request_id)}`);
      const receipt = await execute(
        "process-liquidity",
        SwapDriver.v0_1.processRequests.invocation(pool.driver, GAS),
      );
      assertLiquidityMint(
        receipt,
        pool.handler,
        accepted.topics.request_id,
        account.address,
        recipient,
      );
      const state = (
        await waitForView(() =>
          SwapHandler.v0_1.poolState.view({
            client,
            address: pool!.handler,
            minStateBlockHeight: height,
          }),
        )
      ).value;
      if (
        state.reserves.some((reserve) => reserve !== LIQUIDITY) ||
        (await balance(pool.liquidity_token, recipient)) <= 0n
      )
        throw new SeedError("Pool reserves or LP balance mismatch");
      for (const token of tokens)
        await execute(
          "distribute-tokens",
          ERC20.v0_1.transfer.invocation(token, GAS, {
            receiver: recipient,
            amount: SUPPLY - LIQUIDITY,
          }),
        );
      for (const token of tokens)
        if ((await balance(token, recipient)) !== SUPPLY - LIQUIDITY)
          throw new SeedError("Recipient token balance mismatch");
    }
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
    if (error instanceof SeedError) console.error(error.message);
    console.error(
      "No writes will be retried. A new run creates new assets; use a fresh node to start over.",
    );
    throw error;
  }
}
