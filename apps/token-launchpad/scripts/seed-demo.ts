import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rmdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import {
  addressFromHex,
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  localnet,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  codec,
  serialize,
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";
import { StandardTokenFactory } from "../src/contracts/generated/standard-token-factory.ts";
import { ERC20Metadata } from "../src/contracts/generated/standard-token.ts";
import { SwapFactory } from "../../swap/src/contracts/generated/swap-factory.ts";
import { SwapRouter } from "../../swap/src/contracts/generated/swap-router.ts";
import {
  SwapDriver,
  RequestAccepted,
} from "../../swap/src/contracts/generated/swap-driver.ts";
import { SwapHandler } from "../../swap/src/contracts/generated/swap-handler.ts";
import type { RegistryStatus, TokenQueryResult } from "../server/domain.ts";
import {
  executeStep,
  durableMkdir,
  saveJson,
  SeedError,
  type SeedJournal,
} from "./seed-journal.ts";
import { validateLocalRpcUrl } from "./setup-local.ts";
import { seedTransport, verifySwapRelationship } from "./seed-preflight.ts";
import {
  completeSeedLiquidity,
  type LiquidityProgress,
} from "./seed-liquidity.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GAS = gasAmount(10_000_000n);
const SUPPLY = 1_000_000n * 1_000_000n;
const LIQUIDITY = 1_000n * 1_000_000n;
const RESERVE = 10_000_000n;
const TOKENS = [
  { name: "Groundhog Demo Dollar", symbol: "gUSD" },
  { name: "Groundhog Demo Euro", symbol: "gEUR" },
] as const;

interface Manifest extends SeedJournal {
  version: 1;
  scope: string;
  signer: string;
  recipient: string;
  tokens: { address: string; nonce: string; name: string; symbol: string }[];
  pool?: { handler: string; driver: string; liquidityToken: string };
  liquidity?: LiquidityProgress;
}

export async function readSeedEnvironment(
  path: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const parsed = parseEnv(await readFile(path, "utf8"));
  return Object.fromEntries(
    keys.map((key) => {
      const value = process.env[key] ?? parsed[key];
      if (!value) throw new SeedError(`Missing public setup setting: ${key}`);
      return [key, value];
    }),
  );
}

export function assertScope(actual: string, expected: string): void {
  if (actual !== expected)
    throw new SeedError("Seed network/factory/owner scope mismatch");
}

export async function seed(phase: "tokens" | "pools"): Promise<void> {
  let context =
    "read public setup environments (run both setup:local commands first)";
  let lock: string | undefined;
  try {
    const common = ["VITE_GROUNDHOG_RPC_URL", "VITE_GROUNDHOG_NETWORK_ID"];
    const launch = await readSeedEnvironment(
      resolve(
        process.env.LAUNCHPAD_APP_ENV ??
          join(ROOT, "apps/token-launchpad/.env.local"),
      ),
      [
        ...common,
        "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
        "VITE_STANDARD_TOKEN_HASH",
      ],
    );
    const swap = await readSeedEnvironment(
      resolve(process.env.SWAP_APP_ENV ?? join(ROOT, "apps/swap/.env.local")),
      [
        ...common,
        "VITE_SWAP_FACTORY_ADDRESS",
        "VITE_SWAP_ROUTER_ADDRESS",
        "VITE_POOL_TOKEN_HASH",
      ],
    );
    const hex = (value: string) => toHex0x(sha256Hash(fromHex0x(value)));
    const network = hex(launch.VITE_GROUNDHOG_NETWORK_ID!);
    assertScope(hex(swap.VITE_GROUNDHOG_NETWORK_ID!), network);
    const rpcUrl = validateLocalRpcUrl(
      process.env.GROUNDHOG_RPC_URL ?? launch.VITE_GROUNDHOG_RPC_URL!,
    );
    if (!process.env.GROUNDHOG_RPC_URL)
      assertScope(validateLocalRpcUrl(swap.VITE_GROUNDHOG_RPC_URL!), rpcUrl);
    const factory = addressFromHex(launch.VITE_STANDARD_TOKEN_FACTORY_ADDRESS!);
    const swapFactory = addressFromHex(swap.VITE_SWAP_FACTORY_ADDRESS!);
    const router = addressFromHex(swap.VITE_SWAP_ROUTER_ADDRESS!);
    const tokenHash = hex(launch.VITE_STANDARD_TOKEN_HASH!);
    const poolHash = hex(swap.VITE_POOL_TOKEN_HASH!);
    const scope = JSON.stringify({
      network,
      factory: toHex0x(factory),
      swapFactory: toHex0x(swapFactory),
      router: toHex0x(router),
      tokenHash,
      poolHash,
    });
    context =
      "verify live network and launchpad registry; start the registry for this setup before seeding";
    const client = await createGroundhogClient({
      cluster: localnet({
        rpcUrl,
        networkHash: networkHash(sha256Hash(fromHex0x(network))),
      }),
      transport: seedTransport(rpcUrl),
    });
    const verifyNetwork = async () =>
      assertScope(
        toHex0x((await client.getNetworkInfo()).networkHash),
        network,
      );
    await verifyNetwork();
    const registryUrl = validateLocalRpcUrl(
      process.env.LAUNCHPAD_REGISTRY_URL ?? "http://127.0.0.1:3001",
    );
    const api = async <T>(path: string, method = "GET"): Promise<T> => {
      const response = await fetch(new URL(path, registryUrl), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Launchpad registry request failed");
      return (await response.json()) as T;
    };
    const verifyRegistry = async () => {
      const status = await api<RegistryStatus>("/api/registry/status");
      assertScope(status.networkId, network.slice(2));
      assertScope(status.factoryAddress, toHex0x(factory));
      if (status.syncState === "integrityFault" || status.historyLimited)
        throw new Error("Registry history unavailable or integrity fault");
    };
    await verifyRegistry();
    const config = (
      await StandardTokenFactory.config.view({ client, contract: factory })
    ).value;
    if (
      toHex0x(config.token_code_hash) !== tokenHash ||
      !bytesEqual(config.native_token, HOG_ADDRESS) ||
      config.creation_fee !== 0n ||
      config.required_token_funding <= 0n
    )
      throw new Error("Unsupported live launchpad factory configuration");
    const funding = (
      await SwapFactory.poolFunding.view({ client, contract: swapFactory })
    ).value;
    if (
      funding.min <= 0n ||
      funding.recommended < funding.min ||
      funding.recommended > ((1n << 128n) - 1n) / 3n
    )
      throw new Error("Invalid pool funding policy");

    context = "verify the live swap factory/router relationship before seeding";
    await verifySwapRelationship(client, swapFactory, router);

    context = "open network/factory-scoped seed state and tool-only signer";
    const directory = join(
      resolve(process.env.SEED_STATE_DIR ?? join(ROOT, ".local/seed")),
      createHash("sha256").update(scope).digest("hex"),
    );
    await durableMkdir(directory);
    const lockPath = join(directory, "lock");
    console.log(`Seed state: ${directory}`);
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SeedError(
          "Seed state is locked. After confirming no seed process is running, remove only the empty lock directory and rerun.",
        );
      }
      throw error;
    }
    lock = lockPath;
    const manifestPath = join(directory, "manifest.json");
    const keyPath = join(directory, "signer.key");
    let manifest: Manifest | undefined;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (phase === "pools" && !manifest)
      throw new Error("Run seed:tokens first");
    let key: Buffer;
    try {
      key = await readFile(keyPath);
      if (key.length !== 32 || ((await stat(keyPath)).mode & 0o077) !== 0)
        throw new Error("Seed signer must contain 32 bytes with mode 0600");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manifest)
        throw error;
      key = randomBytes(32);
      const file = await open(keyPath, "wx", 0o600);
      try {
        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const account = createPubkeyAccount({
      signer: new PrivateKeySigner(new Uint8Array(key)),
    });
    key.fill(0);
    const wallet = createWalletClient({ client, account });
    const signer = toHex0x(account.address);
    const recipient = addressFromHex(
      process.env.SEED_RECIPIENT ?? manifest?.recipient ?? signer,
    );
    if (manifest) {
      assertScope(manifest.scope, scope);
      assertScope(manifest.signer, signer);
      assertScope(manifest.recipient, toHex0x(recipient));
      if (
        manifest.version !== 1 ||
        manifest.tokens.length !== 2 ||
        typeof manifest.steps !== "object"
      )
        throw new Error("Invalid seed manifest");
    } else {
      const tokens = [];
      for (const token of TOKENS) {
        const nonce = fixedBytes(randomBytes(32), 32);
        const address = (
          await StandardTokenFactory.predictToken.view({
            client,
            contract: factory,
            args: { creator: account.address, nonce },
          })
        ).value;
        tokens.push({
          ...token,
          nonce: toHex0x(nonce),
          address: toHex0x(address),
        });
      }
      manifest = {
        version: 1,
        scope,
        signer,
        recipient: toHex0x(recipient),
        tokens,
        steps: {},
      };
      await saveJson(manifestPath, manifest);
    }
    const state = manifest;
    console.log(
      `Seed manifest: ${manifestPath}\nTool account: ${signer}\nRecipient: ${state.recipient}`,
    );
    const save = () => saveJson(manifestPath, state);
    const execute = async (
      name: string,
      invocation: Invocation,
      contractsToDeploy: Contract[] = [],
    ) => {
      context = `step ${name}; original hashes are in the seed manifest`;
      console.log(`Checking ${name}`);
      await verifyNetwork();
      return executeStep({
        name,
        intent: toHex0x(serialize(invocation, codec.Invocation)),
        journal: state,
        save,
        client,
        retryFailed: process.env.SEED_RETRY_FAILED === "1",
        prepare: async () => {
          // Airdrop is a dev-node funding operation, not a contract creation.
          if (
            (await wallet.getBalance()).rawBalance <
            RESERVE * 10n + funding.recommended * 3n
          )
            await wallet.requestAirdrop();
          return wallet.signTransaction(
            await wallet.prepareExecution({
              invocation,
              gasLimit: GAS,
              contractsToDeploy,
              expiryBlocks: 1_000n,
            }),
          );
        },
      });
    };
    const artifact = async (
      app: string,
      hash: string,
      override: string | undefined,
    ): Promise<Contract> => {
      const value = JSON.parse(
        await readFile(
          join(
            resolve(override ?? join(ROOT, `apps/${app}/public`)),
            "contract-artifacts",
            `${hash}.json`,
          ),
          "utf8",
        ),
      ) as { contractType: string; hash: string; data: string };
      const contract: Contract = {
        contract_type: ContractType.kRv32,
        rv32_contract: { data: fromHex0x(value.data) },
      };
      if (
        value.contractType !== "rv32" ||
        value.hash !== hash ||
        toHex0x(hashContract(contract)) !== hash
      )
        throw new Error("Setup artifact hash mismatch");
      return contract;
    };
    const transfer = (
      token: ContractAddress,
      receiver: ContractAddress,
      amount: bigint,
    ) => ERC20.transfer.invocation(token, GAS, { receiver, amount });
    const balance = async (token: ContractAddress, addr: ContractAddress) =>
      (
        await ERC20.getBalanceOf.view({
          client,
          contract: token,
          args: { addr },
        })
      ).value;
    const verifyToken = async (index: number) => {
      const token = state.tokens[index]!;
      const expected = TOKENS[index]!;
      if (token.name !== expected.name || token.symbol !== expected.symbol)
        throw new Error("Seed token intent changed");
      const predicted = (
        await StandardTokenFactory.predictToken.view({
          client,
          contract: factory,
          args: {
            creator: account.address,
            nonce: fixedBytes(fromHex0x(token.nonce), 32),
          },
        })
      ).value;
      assertScope(toHex0x(predicted), token.address);
      const options = { client, contract: predicted };
      if (
        (await ERC20Metadata.name.view(options)).value !== token.name ||
        (await ERC20Metadata.symbol.view(options)).value !== token.symbol ||
        (await ERC20Metadata.decimals.view(options)).value !== 6n ||
        (await ERC20.totalSupply.view(options)).value !== SUPPLY
      )
        throw new Error("Live seed token metadata or supply mismatch");
    };
    const indexedTokens = async () => {
      await verifyRegistry();
      for (const token of state.tokens) {
        const result = await api<TokenQueryResult>(
          `/api/tokens?tokenAddress=${token.address}`,
        );
        if (result.total === 0) return false;
        const row = result.tokens[0];
        const txHash = state.steps[`create-${token.symbol}`]?.at(-1)?.hash;
        if (
          result.total !== 1 ||
          !row ||
          row.tokenAddress !== token.address ||
          row.networkId !== network.slice(2) ||
          row.factoryAddress !== toHex0x(factory) ||
          row.transactionHash !== txHash ||
          row.tokenCodeHash !== tokenHash ||
          row.creatorAddress !== signer ||
          row.initialHolderAddress !== signer ||
          row.administratorAddress !== state.recipient ||
          row.initialSupply !== SUPPLY.toString() ||
          row.decimals !== 6 ||
          row.name !== token.name ||
          row.symbol !== token.symbol
        )
          throw new Error("Registry seed evidence mismatch");
      }
      return true;
    };

    if (phase === "tokens") {
      context = "validate immutable token code artifact";
      const code = await artifact(
        "token-launchpad",
        tokenHash,
        process.env.LAUNCHPAD_APP_PUBLIC_DIR,
      );
      for (const [index, token] of state.tokens.entries()) {
        const address = addressFromHex(token.address);
        const predicted = (
          await StandardTokenFactory.predictToken.view({
            client,
            contract: factory,
            args: {
              creator: account.address,
              nonce: fixedBytes(fromHex0x(token.nonce), 32),
            },
          })
        ).value;
        assertScope(toHex0x(predicted), token.address);
        assertScope(token.symbol, TOKENS[index]!.symbol);
        assertScope(token.name, TOKENS[index]!.name);
        await execute(
          `fund-${token.symbol}`,
          transfer(
            HOG_ADDRESS,
            address,
            config.required_token_funding + 1_234n + RESERVE,
          ),
        );
        await execute(
          `create-${token.symbol}`,
          StandardTokenFactory.createToken.invocation(factory, GAS, {
            nonce: fixedBytes(fromHex0x(token.nonce), 32),
            administrator: recipient,
            initialHolder: account.address,
            initialSupply: SUPPLY,
            name: token.name,
            symbol: token.symbol,
            decimals: 6n,
          }),
          [code],
        );
        await verifyToken(index);
      }
      context =
        "wait for canonical launchpad indexing through registry HTTP API";
      await api("/api/registry/sync", "POST");
      const deadline = Date.now() + 60_000;
      while (!(await indexedTokens())) {
        if (Date.now() >= deadline)
          throw new Error(
            "Registry indexing timeout; rerun to observe existing creations",
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      console.log(
        "Demo tokens created and canonically indexed: gUSD, gEUR (1,000,000 each; 6 decimals).",
      );
      return;
    }

    context =
      "resolve exact seeded addresses through launchpad registry and validate live tokens";
    if (!(await indexedTokens()))
      throw new Error("Seed tokens are not indexed; run seed:tokens");
    for (let index = 0; index < state.tokens.length; index++)
      await verifyToken(index);
    const [tokenA, tokenB] = state.tokens.map((token) =>
      addressFromHex(token.address),
    ) as [ContractAddress, ContractAddress];
    const pairArgs = { tokenA, tokenB };
    const options = { client, contract: swapFactory, args: pairArgs };
    const existing = (await SwapFactory.getPair.view(options)).value;
    if (existing && !state.steps["create-pair"])
      throw new Error("Pair already exists outside this seed run");
    context = "validate immutable LP code artifact";
    const code = await artifact(
      "swap",
      poolHash,
      process.env.SWAP_APP_PUBLIC_DIR,
    );
    await execute(
      "approve-pool-funding",
      ERC20.adjustAllowance.invocation(HOG_ADDRESS, GAS, {
        spender: swapFactory,
        diff: funding.recommended * 3n,
      }),
    );
    await execute(
      "create-pair",
      SwapFactory.createPair.invocation(swapFactory, GAS, {
        ...pairArgs,
        funding: funding.recommended,
      }),
      [code],
    );
    const pool = (await SwapFactory.poolAddresses.view(options)).value;
    const livePair = (await SwapFactory.getPair.view(options)).value;
    if (!livePair || !bytesEqual(livePair, pool.handler))
      throw new Error("Created pool address mismatch");
    const poolRecord = {
      handler: toHex0x(pool.handler),
      driver: toHex0x(pool.driver),
      liquidityToken: toHex0x(pool.liquidity_token),
    };
    if (state.pool)
      assertScope(JSON.stringify(state.pool), JSON.stringify(poolRecord));
    state.pool = poolRecord;
    await save();
    for (const token of [tokenA, tokenB]) {
      await execute(
        `approve-liquidity-${toHex0x(token)}`,
        ERC20.adjustAllowance.invocation(token, GAS, {
          spender: pool.handler,
          diff: LIQUIDITY,
        }),
      );
    }
    if (
      !state.steps["add-liquidity"] &&
      ((await balance(tokenA, account.address)) < LIQUIDITY ||
        (await balance(tokenB, account.address)) < LIQUIDITY)
    )
      throw new SeedError(
        "Seed signer does not own the required initial liquidity",
      );
    const queued = await execute(
      "add-liquidity",
      SwapRouter.addLiquidity.invocation(router, GAS, {
        ...pairArgs,
        amountsDesired: [LIQUIDITY, LIQUIDITY],
        amountsMin: [LIQUIDITY, LIQUIDITY],
        recipient,
      }),
    );
    const accepted = RequestAccepted.allFromReceipt(queued, {
      contractAddress: pool.driver,
    });
    if (accepted.length !== 1)
      throw new Error("Expected one liquidity request acceptance event");
    const requestId = accepted[0]!.topics.request_id;
    await completeSeedLiquidity({
      state,
      save,
      client,
      queued,
      requestId,
      handler: pool.handler,
      driver: pool.driver,
      signer: account.address,
      recipient,
      crank: (name) =>
        execute(name, SwapDriver.processRequests.invocation(pool.driver, GAS)),
    });
    context =
      "verify correlated liquidity mint, live reserves and recipient LP balance";
    const live = (
      await SwapHandler.poolState.view({ client, contract: pool.handler })
    ).value;
    if (
      !bytesEqual(live.liquidity_token, pool.liquidity_token) ||
      live.reserves[0] <= 0n ||
      live.reserves[1] <= 0n ||
      (await balance(pool.liquidity_token, recipient)) <= 0n
    )
      throw new SeedError(
        "Liquidity mint could not be verified; inspect the queued request and crank receipts",
      );
    if (!bytesEqual(recipient, account.address)) {
      for (const token of [tokenA, tokenB])
        await execute(
          `distribute-${toHex0x(token)}`,
          transfer(token, recipient, SUPPLY - LIQUIDITY),
        );
    }
    console.log(
      `Demo pool ready: ${poolRecord.handler}\nInitial liquidity: 1,000 gUSD + 1,000 gEUR. LP and remaining supply owner: ${state.recipient}`,
    );
  } catch (error) {
    console.error(`Unable to complete: ${context}.`);
    if (error instanceof SeedError) console.error(error.message);
    throw error;
  } finally {
    if (lock) await rmdir(lock);
  }
}
