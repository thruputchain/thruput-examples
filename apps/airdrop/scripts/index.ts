import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import {
  addressFromBase58,
  bytesEqual,
  createThruputClient,
  defineCluster,
  fixedBytes,
  fromHex0x,
  hashContract,
  hashFromBase58,
  HttpTransport,
  parseUnits,
  toBase58,
  type RpcStorageCosts,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
  networkHash,
  type Contract,
  type Invocation,
} from "@thruputchain/protocol";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../../token-launchpad/src/contracts/generated/standard-token-factory";
import { SwapFactory } from "../../swap/src/contracts/generated/swap-factory";
import { SwapRouter } from "../../swap/src/contracts/generated/swap-router";
import {
  SwapDriver,
  batch_driver,
} from "../../swap/src/contracts/generated/swap-driver";
import { SwapHandler } from "../../swap/src/contracts/generated/swap-handler";
import {
  waitForView,
  verifySwapRelationship,
} from "../../../scripts/seed/seed-preflight";
import { assertLiquidityMint } from "../../../scripts/seed/seed-liquidity";
import { createPersona, createRun, record, saveRun, checkNetwork } from "./run";
import { address, parseTokens, type Token } from "../shared/config";
import { Airdrop } from "../src/contracts/generated/airdrop";
import { parseRpcUrl } from "../server/config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const GAS = gasAmount(20_000_000n);
const ASSETS = [
  { symbol: "tUSDC", name: "Test USDC", decimals: 6, amount: "1000" },
  { symbol: "tEURC", name: "Test EURC", decimals: 6, amount: "1000" },
  { symbol: "tBTC", name: "Test BTC", decimals: 8, amount: "0.01" },
  { symbol: "tETH", name: "Test ETH", decimals: 8, amount: "0.1" },
  { symbol: "tXLM", name: "Test XLM", decimals: 7, amount: "1000" },
  { symbol: "tUSDT", name: "Test USDT", decimals: 6, amount: "1000" },
  { symbol: "tXAUM", name: "Test XAUM", decimals: 8, amount: "0.1" },
] as const;

export async function setup(
  env: Record<string, string | undefined> = process.env,
  mode: "local" | "devnet" = "local",
) {
  const output = resolve(
    root,
    env.AIRDROP_ENV_PATH || `apps/airdrop/.env.${mode}`,
  );
  try {
    await lstat(output);
    throw new Error(
      "Airdrop environment already exists. Select a new AIRDROP_ENV_PATH.",
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const jsonFile = async (path: string) =>
    JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
  const custom = env.AIRDROP_TOKENS_FILE
    ? parseTokens(await jsonFile(env.AIRDROP_TOKENS_FILE))
    : null;
  const list = env.AIRDROP_ADDRESSES_FILE
    ? await jsonFile(env.AIRDROP_ADDRESSES_FILE)
    : [];
  if (
    !Array.isArray(list) ||
    list.length > 256 ||
    list.some((v) => typeof v !== "string")
  )
    throw new Error("Use an array of at most 256 eligible addresses.");
  const addresses = list.map((v) => address(v as string));
  if (new Set(addresses).size !== addresses.length)
    throw new Error("Eligible addresses must be unique.");
  const packs = BigInt(env.AIRDROP_PACKS || "1000");
  if (packs < 1n || packs > 10000n)
    throw new Error("AIRDROP_PACKS must be between 1 and 10000.");
  const environment = async (path: string) =>
    parseEnv(await readFile(resolve(root, path), "utf8"));
  const launch = custom
    ? null
    : await environment(
        env.LAUNCHPAD_APP_ENV || `apps/token-launchpad/.env.${mode}`,
      );
  const swap = custom
    ? null
    : await environment(env.SWAP_APP_ENV || `apps/swap/.env.${mode}`);
  const rpcUrl = parseRpcUrl(
    env.THRUPUT_RPC_URL ||
      launch?.VITE_THRUPUT_RPC_URL ||
      (mode === "local"
        ? "http://127.0.0.1:9545"
        : "https://rpc.thruput.network"),
  );
  let expectedNetwork =
    env.THRUPUT_NETWORK_ID === undefined
      ? undefined
      : toBase58(hashFromBase58(env.THRUPUT_NETWORK_ID));
  if (env.THRUPUT_RUNTIME_MANIFEST) {
    const manifest = (await jsonFile(env.THRUPUT_RUNTIME_MANIFEST)) as {
      networkHash?: string;
    };
    const recorded = toBase58(hashFromBase58(manifest.networkHash ?? ""));
    if (expectedNetwork !== undefined && expectedNetwork !== recorded)
      throw new Error("Runtime manifest and THRUPUT_NETWORK_ID disagree.");
    expectedNetwork = recorded;
  }
  if (custom && !env.AIRDROP_DEPLOYER_PRIVATE_KEY)
    throw new Error(
      "Set AIRDROP_DEPLOYER_PRIVATE_KEY to the signer that owns the selected tokens.",
    );
  if (
    env.AIRDROP_DEPLOYER_PRIVATE_KEY &&
    !/^0x[0-9a-fA-F]{64}$/.test(env.AIRDROP_DEPLOYER_PRIVATE_KEY)
  )
    throw new Error("Invalid deployer key.");
  const client = await createThruputClient({
    cluster: defineCluster({
      name: mode,
      rpcUrl,
      capabilities: ["airdrop"],
      ...(expectedNetwork === undefined
        ? {}
        : { networkHash: networkHash(hashFromBase58(expectedNetwork)) }),
    }),
    transport: new HttpTransport(rpcUrl, {
      timeoutMs: 10000,
      fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    }),
  });
  const network = toBase58(client.network.networkHash);
  if (
    launch &&
    swap &&
    (launch.VITE_THRUPUT_NETWORK_ID !== network ||
      swap.VITE_THRUPUT_NETWORK_ID !== network)
  )
    throw new Error("Launchpad and Swap must use this network.");
  const anchor = await client.getBlockByHeight({ blockHeight: 1n });
  if (!anchor) throw new Error("Chain checkpoint is unavailable.");
  const code = await readFile(
    resolve(root, env.AIRDROP_ARTIFACT || "target/thruput/airdrop.rv32a"),
  );
  const execution = (await client.getChainConfig()).execution;
  if (!execution)
    throw new Error(
      "RPC must expose execution storage costs for provisioning.",
    );
  const funding = storageFunding(
    execution.storageCosts,
    packs,
    addresses.length,
    code.length,
  );
  const run = await createRun(
    resolve(
      root,
      env.AIRDROP_SETUP_DIR || resolve(dirname(output), ".local/airdrop-setup"),
    ),
    network,
    toBase58(anchor.blockHash),
  );
  console.log(`Run: ${run.directory}`);
  try {
    const persona = await createPersona(
      client,
      run,
      "Airdrop Deployer",
      env.AIRDROP_DEPLOYER_PRIVATE_KEY,
    );
    const { account, wallet } = persona;
    async function fundPersona(minimum = 100_000_000n) {
      let balance = (await wallet.getBalance()).rawBalance;
      while (balance < minimum) {
        await checkNetwork(client, run);
        await record(run, `Fund ${persona.name}`, async () => {
          const funded = await wallet.requestAirdrop({ timeoutMs: 60_000 });
          return {
            hash: funded.transactionHash,
            blockHeight: funded.blockHeight,
          };
        });
        const next = (await wallet.getBalance()).rawBalance;
        if (next <= balance)
          throw new Error(
            "Native funding is not visible yet. Inspect the original request before continuing.",
          );
        balance = next;
      }
    }
    const execute = async (
      name: string,
      invocation: Invocation,
      contractsToDeploy: Contract[] = [],
    ) => {
      await fundPersona();
      const result = await record(run, name, () =>
        wallet.executeAndWait(
          { invocation, contractsToDeploy, gasLimit: GAS },
          { timeoutMs: 60_000 },
        ),
      );
      return result.receipt;
    };
    async function artifact(
      directory: string,
      hash: string,
    ): Promise<Contract> {
      const value = JSON.parse(
        await readFile(
          resolve(root, directory, "contract-artifacts", `${hash}.json`),
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
        throw new Error("Artifact hash mismatch.");
      return contract;
    }
    const tokens: Token[] = custom || [];
    async function createDemoAssets() {
      if (!launch || !swap) return;
      const factory = addressFromBase58(
        launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!,
      );
      const poolFactory = addressFromBase58(swap.VITE_SWAP_FACTORY_ADDRESS!),
        router = addressFromBase58(swap.VITE_SWAP_ROUTER_ADDRESS!);
      await verifySwapRelationship(client, poolFactory, router);
      const policy = (
        await StandardTokenFactory.v0_1.config.view({
          client,
          address: factory,
        })
      ).value;
      if (
        toBase58(policy.token_code_hash) !== launch.VITE_STANDARD_TOKEN_HASH ||
        !bytesEqual(policy.native_token, NATIVE_TOKEN_ADDRESS) ||
        policy.creation_fee !== 0n ||
        policy.fee_recipient !== null ||
        policy.required_token_funding <= 0n
      )
        throw new Error("Unsupported token factory configuration.");
      const funding = (
        await SwapFactory.v0_1.poolFunding.view({
          client,
          address: poolFactory,
        })
      ).value;
      if (funding.min <= 0n || funding.recommended < funding.min)
        throw new Error("Invalid pool funding policy.");
      const tokenCode = await artifact(
        env.LAUNCHPAD_APP_PUBLIC_DIR || "apps/token-launchpad/public",
        launch.VITE_STANDARD_TOKEN_HASH!,
      );
      const poolCode = await artifact(
        env.SWAP_APP_PUBLIC_DIR || "apps/swap/public",
        swap.VITE_POOL_TOKEN_HASH!,
      );
      for (const asset of ASSETS) {
        const nonce = fixedBytes(randomBytes(32), 32);
        const token = (
          await StandardTokenFactory.v0_1.predictToken.view({
            client,
            address: factory,
            args: { creator: account.address, nonce },
          })
        ).value;
        const claimAmount = parseUnits(asset.amount, asset.decimals);
        const supply =
          claimAmount * (asset.symbol === "tUSDC" ? 20000n : 12000n);
        await execute(
          `fund-${asset.symbol}`,
          ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
            receiver: token,
            amount: policy.required_token_funding + 10000000n,
          }),
        );
        const receipt = await execute(
          `create-${asset.symbol}`,
          StandardTokenFactory.v0_1.createToken.invocation(factory, GAS, {
            nonce,
            administrator: account.address,
            initialHolder: account.address,
            initialSupply: supply,
            name: asset.name,
            symbol: asset.symbol,
            decimals: BigInt(asset.decimals),
          }),
          [tokenCode],
        );
        const created =
          standard_token_factory_if.v0_1.events.TokenCreated.singleFromReceipt(
            receipt,
            { address: factory },
          );
        if (
          !bytesEqual(created.topics.token, token) ||
          !bytesEqual(created.topics.creator, account.address) ||
          created.fields.initial_supply !== supply
        )
          throw new Error("Token creation evidence mismatch.");
        tokens.push({
          address: toBase58(token),
          symbol: asset.symbol,
          name: asset.name,
          decimals: asset.decimals,
          claimAmount: String(claimAmount),
        });
        await writeFile(
          resolve(run.directory, "tokens.json"),
          JSON.stringify(tokens, null, 2),
          { mode: 0o600 },
        );
      }
      const pools = [];
      for (const token of tokens.slice(1)) {
        const ordered = [tokens[0]!, token].sort((a, b) =>
          Buffer.compare(
            addressFromBase58(a.address),
            addressFromBase58(b.address),
          ),
        );
        const tokenA = addressFromBase58(ordered[0]!.address),
          tokenB = addressFromBase58(ordered[1]!.address);
        const amounts: [bigint, bigint] = [
          BigInt(ordered[0]!.claimAmount) * 1000n,
          BigInt(ordered[1]!.claimAmount) * 1000n,
        ];
        await execute(
          `approve-${token.symbol}-funding`,
          ERC20.v0_1.adjustAllowance.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
            spender: poolFactory,
            difference: funding.recommended * 3n,
          }),
        );
        await execute(
          `pair-${token.symbol}`,
          SwapFactory.v0_1.createPair.invocation(poolFactory, GAS, {
            tokenA,
            tokenB,
            funding: funding.recommended,
          }),
          [poolCode],
        );
        const pool = (
          await waitForView(() =>
            SwapFactory.v0_1.poolAddresses.view({
              client,
              address: poolFactory,
              args: { tokenA, tokenB },
              minStateBlockHeight: run.latestBlockHeight,
            }),
          )
        ).value;
        for (const [tokenAddress, amount] of [
          [tokenA, amounts[0]],
          [tokenB, amounts[1]],
        ] as const)
          await execute(
            `approve-${token.symbol}`,
            ERC20.v0_1.adjustAllowance.invocation(tokenAddress, GAS, {
              spender: pool.handler,
              difference: amount,
            }),
          );
        const queued = await execute(
          `liquidity-${token.symbol}`,
          SwapRouter.v0_1.addLiquidity.invocation(router, GAS, {
            tokenA,
            tokenB,
            amountsDesired: amounts,
            amountsMin: amounts,
            recipient: account.address,
          }),
        );
        const accepted =
          batch_driver.v0_1.events.RequestAccepted.singleFromReceipt(queued, {
            address: pool.driver,
          });
        const receipt = await execute(
          `process-${token.symbol}`,
          SwapDriver.v0_1.processRequests.invocation(pool.driver, GAS),
        );
        assertLiquidityMint(
          receipt,
          pool.handler,
          accepted.topics.request_id,
          account.address,
          account.address,
        );
        const state = (
          await waitForView(() =>
            SwapHandler.v0_1.poolState.view({
              client,
              address: pool.handler,
              minStateBlockHeight: run.latestBlockHeight,
            }),
          )
        ).value;
        if (state.reserves.some((value, index) => value !== amounts[index]))
          throw new Error("Pool reserves mismatch.");
        pools.push({
          token: token.address,
          quote: tokens[0]!.address,
          handler: toBase58(pool.handler),
          driver: toBase58(pool.driver),
        });
        await writeFile(
          resolve(run.directory, "pools.json"),
          JSON.stringify(pools, null, 2),
          { mode: 0o600 },
        );
      }
    }
    // Validate the supplied metadata and budget before deploying the claim contract.
    async function verifyTokens() {
      for (const token of tokens) {
        const options = {
          client,
          address: addressFromBase58(token.address),
          minStateBlockHeight: run.latestBlockHeight,
        };
        const [symbol, decimals, balance] = await Promise.all([
          waitForView(() => ERC20Metadata.v0_1.symbol.view(options)),
          waitForView(() => ERC20Metadata.v0_1.decimals.view(options)),
          waitForView(() =>
            ERC20.v0_1.getBalanceOf.view({
              ...options,
              args: { addr: account.address },
            }),
          ),
        ]);
        if (
          symbol.value !== token.symbol ||
          Number(decimals.value) !== token.decimals ||
          balance.value < BigInt(token.claimAmount) * packs
        )
          throw new Error(
            `Token metadata or deployer balance mismatch for ${token.symbol}.`,
          );
      }
    }
    const deployment = prepareContractDeployment({
      deployer: account.address,
      contract: code,
    });
    run.manifest.airdropAddress = toBase58(deployment.address);
    await saveRun(run);
    async function deployAirdrop() {
      await fundPersona(
        funding.airdrop + funding.token * BigInt(tokens.length) + 100_000_000n,
      );
      await record(run, "Deploy and initialize Airdrop", () =>
        wallet.deployContractAndWait(
          deployment,
          {
            gasLimit: GAS,
            amount: funding.airdrop,
            initializer: Airdrop.v0_1.initialize.invocation(
              deployment.address,
              GAS,
              {
                rewards: tokens.map((t) => ({
                  token: addressFromBase58(t.address),
                  amount: BigInt(t.claimAmount),
                })),
                addresses: addresses.map(addressFromBase58),
              },
            ),
          },
          { timeoutMs: 60_000 },
        ),
      );
    }
    async function fundRewards() {
      for (const token of tokens) {
        const tokenAddress = addressFromBase58(token.address);
        await execute(
          `storage-${token.symbol}`,
          ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
            receiver: tokenAddress,
            amount: funding.token,
          }),
        );
        await execute(
          `distribute-${token.symbol}`,
          ERC20.v0_1.transfer.invocation(tokenAddress, GAS, {
            receiver: deployment.address,
            amount: BigInt(token.claimAmount) * packs,
          }),
        );
      }
    }
    async function verifyAirdrop() {
      const configuration = (
        await waitForView(() =>
          Airdrop.v0_1.config.view({
            client,
            address: deployment.address,
            minStateBlockHeight: run.latestBlockHeight,
          }),
        )
      ).value;
      if (
        configuration.restricted !== addresses.length > 0 ||
        configuration.rewards.length !== tokens.length ||
        configuration.rewards.some(
          (reward, index) =>
            toBase58(reward.token) !== tokens[index]!.address ||
            reward.amount !== BigInt(tokens[index]!.claimAmount),
        )
      )
        throw new Error("Airdrop configuration mismatch.");
      for (const token of tokens) {
        const balance = await waitForView(() =>
          ERC20.v0_1.getBalanceOf.view({
            client,
            address: addressFromBase58(token.address),
            args: { addr: deployment.address },
            minStateBlockHeight: run.latestBlockHeight,
          }),
        );
        if (balance.value !== BigInt(token.claimAmount) * packs)
          throw new Error(
            `Airdrop reward balance mismatch for ${token.symbol}.`,
          );
      }
      for (const eligible of addresses) {
        const result = await waitForView(() =>
          Airdrop.v0_1.eligible.view({
            client,
            address: deployment.address,
            args: { address: addressFromBase58(eligible) },
            minStateBlockHeight: run.latestBlockHeight,
          }),
        );
        if (!result.value) throw new Error("Airdrop eligibility mismatch.");
      }
      await checkNetwork(client, run);
    }

    await createDemoAssets();
    await verifyTokens();
    await deployAirdrop();
    await fundRewards();
    await verifyAirdrop();
    const config = {
      THRUPUT_RPC_URL: rpcUrl,
      THRUPUT_NETWORK_ID: network,
      AIRDROP_ANCHOR_HEIGHT: "1",
      AIRDROP_ANCHOR_HASH: toBase58(anchor.blockHash),
      AIRDROP_ADDRESS: toBase58(deployment.address),
      AIRDROP_TOKENS: JSON.stringify(tokens).replaceAll("'", "\\u0027"),
      SWAP_APP_URL:
        mode === "local"
          ? "http://127.0.0.1:5174/"
          : "https://examples.thruput.network/swap/",
    };
    await mkdir(dirname(output), { recursive: true });
    const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(
        temporary,
        Object.entries(config)
          .map(([key, value]) => `${key}='${value}'`)
          .join("\n") + "\n",
        { flag: "wx", mode: 0o600, flush: true },
      );
      // Publish atomically without replacing an existing distribution, even in a race.
      await link(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
    run.manifest.status = "complete";
    await saveRun(run);
    console.log(
      `Airdrop ready: ${toBase58(deployment.address)}. Configuration: ${output}`,
    );
    return {
      client,
      address: deployment.address,
      tokens,
      directory: run.directory,
      output,
    };
  } catch (error) {
    run.manifest.status = "failed";
    run.manifest.error = error instanceof Error ? error.message : String(error);
    await saveRun(run);
    throw error;
  }
}

export function storageFunding(
  costs: RpcStorageCosts,
  packs: bigint,
  addresses: number,
  codeBytes: number,
) {
  // Reserve 1 KiB per map entry and 4 KiB for configuration, above encoded sizes.
  const entry = costs.baseDataItemCost + 1024n * costs.bytestringCostPerByte;
  return {
    airdrop:
      costs.baseContractDeploymentCost +
      BigInt(codeBytes) * costs.contractDeploymentCostPerByte +
      costs.balanceCost +
      costs.baseDataItemCost +
      4096n * costs.bytestringCostPerByte +
      (packs + BigInt(addresses)) * entry,
    token: (packs + 1n) * entry,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { network: { type: "string", default: "local" } },
  });
  if (values.network !== "local" && values.network !== "devnet")
    throw new Error("Use --network local or --network devnet.");
  await setup(process.env, values.network);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
