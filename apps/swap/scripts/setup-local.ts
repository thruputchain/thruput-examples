import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  bytesEqual,
  createGroundhogClient,
  createTransaction,
  fromHex0x,
  hashContract,
  HttpTransport,
  PrivateKeySigner,
  signTransaction,
  toHex0x,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import { fixedBytes } from "@groundhogchain/client/contract";
import {
  loadLocalDevAccount,
  type LocalDevAccount,
} from "@groundhogchain/client/local-dev";
import {
  AuthClaimType,
  ContractType,
  ExecResult,
  HOG_ADDRESS,
  bitMap,
  blockHeight,
  codec,
  gasAmount,
  sha256Hash,
  weight,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";
import { serialize } from "@groundhogchain/xdr";
import { stringify } from "smol-toml";

import { ERC20, ERC20Metadata } from "../src/contracts/generated/erc20";
import { DevWallet } from "../src/contracts/generated/dev-wallet";
import { SwapDriver } from "../src/contracts/generated/swap-driver";
import {
  SwapFactory,
  type Pool,
} from "../src/contracts/generated/swap-factory";
import { SwapPair } from "../src/contracts/generated/swap-pair";
import { SwapRouter } from "../src/contracts/generated/swap-router";

const GAS_LIMIT = gasAmount(10_000_000n);
const EXPIRY_BLOCKS = 1_000n;
const CONTRACT_FUNDING = 10_000_000n;
const MINT_AMOUNT = 2_000_000_000n;
const LIQUIDITY_AMOUNT = 1_000_000_000n;
const TOKEN_DECIMALS = 6n;
const SUPPORTED_WIRE_FORMAT = /^3\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

interface RuntimeManifest {
  networkHash: string;
  bootstrapAccountDerivation: { seed: string };
  bootstrapAccounts: Array<{
    index: number;
    role: "faucet" | "local_user";
    publicKey: string;
    walletAddress: string;
  }>;
}

interface Artifacts {
  erc20: Contract;
  factory: Contract;
  router: Contract;
  handler: Contract;
  driver: Contract;
  pair: Contract;
}

interface Deployment {
  personas: Persona[];
  tokenA: ContractAddress;
  tokenB: ContractAddress;
  tokenC: ContractAddress;
  factory: ContractAddress;
  router: ContractAddress;
  pool: Pool;
}

interface Persona {
  id: "alice" | "bob" | "carol";
  label: "Alice" | "Bob" | "Carol";
  account: LocalDevAccount;
  browserPrivateKey: string;
}

const PERSONAS = [
  { id: "alice", label: "Alice" },
  { id: "bob", label: "Bob" },
  { id: "carol", label: "Carol" },
] as const;

/**
 * Loads the active development accounts and compiled contracts, provisions the
 * complete swap environment, then writes the browser and CLI configuration that
 * point at the deployed addresses. No configuration is written until contract
 * provisioning and the initial liquidity check succeed.
 */
async function main(): Promise<void> {
  const manifestPath = resolve(process.env.GROUNDHOG_RUNTIME_MANIFEST!);
  const artifactRoot = resolve(process.env.SWAP_ARTIFACT_ROOT!);
  const appEnvironmentPath = resolve(process.env.SWAP_APP_ENV!);
  const cliConfigPath = join(
    resolve(process.env.SWAP_CLI_CONFIG_HOME!),
    "groundhog/config.toml",
  );
  const rpcUrl = process.env.GROUNDHOG_RPC_URL!;
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as RuntimeManifest;

  const [faucet, users, artifacts] = await Promise.all([
    loadLocalDevAccount({ role: "faucet" }),
    Promise.all(PERSONAS.map((_, roleOffset) =>
      loadLocalDevAccount({ role: "local_user", roleOffset })
    )),
    loadArtifacts(artifactRoot),
  ]);
  if (
    new Set(users.map(({ index }) => index)).size !== PERSONAS.length
    || new Set(users.map(({ address }) => toHex0x(address))).size !== PERSONAS.length
  ) throw new Error("Development wallets must have distinct accounts");
  for (const account of [faucet, ...users]) {
    const recorded = manifest.bootstrapAccounts.find(({ index }) => index === account.index);
    if (
      recorded === undefined
      || recorded.role !== account.role
      || recorded.walletAddress !== toHex0x(account.address)
    ) throw new Error("Runtime manifest changed while loading development wallets");
  }
  const personas = PERSONAS.map((persona, index): Persona => {
    const account = users[index]!;
    const recorded = manifest.bootstrapAccounts.find(({ index }) =>
      index === account.index
    )!;
    const privateKey = createHash("sha256")
      .update(
        `${manifest.bootstrapAccountDerivation.seed}:account-${account.index}`,
      )
      .digest();
    const signer = new PrivateKeySigner(privateKey);
    if (!bytesEqual(signer.publicKey.ed25519, fromHex0x(recorded.publicKey))) {
      throw new Error(`${persona.label}'s development key does not match its account`);
    }
    return {
      ...persona,
      account,
      browserPrivateKey: toHex0x(privateKey),
    };
  });
  const client = createGroundhogClient(new HttpTransport(rpcUrl));
  const version = await client.getVersion();
  if (!SUPPORTED_WIRE_FORMAT.test(version.wireFormat)) {
    throw new Error(
      `Groundhog wire format >=3.0.0 <4.0.0 is required; found ${version.wireFormat}`,
    );
  }
  const requiredPersonaHog = CONTRACT_FUNDING * 4n;
  const personaHogBalances = await Promise.all(personas.map(async (persona) => (
    await ERC20.getBalanceOf.view({
      client,
      contract: HOG_ADDRESS,
      caller: persona.account.address,
      args: { addr: persona.account.address },
    })
  ).value));
  for (const [index, balance] of personaHogBalances.entries()) {
    if (balance < requiredPersonaHog) {
      throw new Error(`${personas[index]!.label} requires at least ${requiredPersonaHog} native HOG`);
    }
  }

  // Fail on invalid output paths before making any changes to the ledger.
  await mkdir(dirname(cliConfigPath), { recursive: true });
  await mkdir(dirname(appEnvironmentPath), { recursive: true });

  const deployment = await configureSwap(
    client,
    faucet,
    personas,
    artifacts,
  );
  const alice = deployment.personas[0]!;

  const cliContents = renderCliConfig(
    manifest.networkHash,
    rpcUrl,
    manifestPath,
    alice.account.keyName,
  );
  const environmentContents = renderEnvironment(
    manifest.networkHash,
    rpcUrl,
    deployment,
  );
  const temporarySuffix = `${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryCliPath = `${cliConfigPath}.${temporarySuffix}`;
  const temporaryEnvironmentPath = `${appEnvironmentPath}.${temporarySuffix}`;

  try {
    await writeFile(temporaryCliPath, cliContents, { mode: 0o600 });
    await writeFile(temporaryEnvironmentPath, environmentContents, {
      mode: 0o600,
    });

    // The browser environment is the completion marker, so publish it last.
    await rename(temporaryCliPath, cliConfigPath);
    await rename(temporaryEnvironmentPath, appEnvironmentPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryCliPath, { force: true }),
      rm(temporaryEnvironmentPath, { force: true }),
      rm(cliConfigPath, { force: true }),
      rm(appEnvironmentPath, { force: true }),
    ]);
    throw error;
  }

  console.log(`
Local swap setup complete
App environment: ${appEnvironmentPath}
CLI configuration: ${cliConfigPath}
Development wallets:
${deployment.personas.map((persona) =>
  `  ${persona.label} ${persona.account.keyName} (${toHex0x(persona.account.address)})`
).join("\n")}
Example tokens:
  gUSD ${toHex0x(deployment.tokenA)}
  gEUR ${toHex0x(deployment.tokenB)}
  gJPY ${toHex0x(deployment.tokenC)}`);
}

/**
 * Deploys three test tokens and the contracts needed to swap between them, funds
 * each contract with native HOG, and seeds a balanced pool. The faucet performs
 * only HOG transfers; Alice deploys the contracts and receives the initial LP.
 */
async function configureSwap(
  client: GroundhogClient,
  faucet: LocalDevAccount,
  personas: Persona[],
  artifacts: Artifacts,
): Promise<Deployment> {
  const alice = personas[0]!.account;
  // 1. Register the pair, handler, and driver binaries. The returned instances
  // are only registration seeds; the factory later deploys the instances used by
  // this pool from these hashes.
  const pairHash = hashContract(artifacts.pair);
  await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(pairHash, 32),
    }),
    [artifacts.pair],
  );

  const handlerHash = hashContract(artifacts.handler);
  await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(handlerHash, 32),
    }),
    [artifacts.handler],
  );

  const driverHash = hashContract(artifacts.driver);
  await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(driverHash, 32),
    }),
    [artifacts.driver],
  );

  // 2. Register the ERC-20 binary while deploying token A, then deploy token B
  // from the registered hash without attaching the same binary again.
  const tokenHash = hashContract(artifacts.erc20);
  const tokenAReceipt = await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(tokenHash, 32),
    }),
    [artifacts.erc20],
  );
  const tokenA = DevWallet.deploy.decodeReceipt(tokenAReceipt).value;

  const tokenBReceipt = await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(tokenHash, 32),
    }),
    [],
  );
  const tokenB = DevWallet.deploy.decodeReceipt(tokenBReceipt).value;

  const tokenCReceipt = await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(tokenHash, 32),
    }),
    [],
  );
  const tokenC = DevWallet.deploy.decodeReceipt(tokenCReceipt).value;

  // 3. Fund each token with native HOG, initialize its administrator and metadata,
  // then mint the balances that the example will use for liquidity and swaps.
  for (const token of [
    { address: tokenA, name: "Groundhog USD", symbol: "gUSD" },
    { address: tokenB, name: "Groundhog EUR", symbol: "gEUR" },
    { address: tokenC, name: "Groundhog JPY", symbol: "gJPY" },
  ]) {
    const fundToken = DevWallet.doAction.invocation(faucet.address, GAS_LIMIT, {
      invocationBytes: serialize(
        ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
          receiver: token.address,
          amount: CONTRACT_FUNDING,
        }),
        codec.Invocation,
      ),
    });
    await submit(client, faucet, fundToken, []);

    const initializeToken = DevWallet.doAction.invocation(
      alice.address,
      GAS_LIMIT,
      {
        invocationBytes: serialize(
          ERC20Metadata.initialize.invocation(token.address, GAS_LIMIT, {
            administrator: alice.address,
            name: token.name,
            symbol: token.symbol,
            decimals: TOKEN_DECIMALS,
          }),
          codec.Invocation,
        ),
      },
    );
    await submit(client, alice, initializeToken, []);

    for (const persona of personas) {
      const mintToken = DevWallet.doAction.invocation(
        alice.address,
        GAS_LIMIT,
        {
          invocationBytes: serialize(
            ERC20.mint.invocation(token.address, GAS_LIMIT, {
              receiver: persona.account.address,
              amount: MINT_AMOUNT,
            }),
            codec.Invocation,
          ),
        },
      );
      await submit(client, alice, mintToken, []);
    }
  }

  // 4. Deploy and fund the factory, then initialize it with every binary hash it
  // needs to create a pair-specific LP token, pair, handler, and driver.
  const factoryHash = hashContract(artifacts.factory);
  const factoryReceipt = await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(factoryHash, 32),
    }),
    [artifacts.factory],
  );
  const factory = DevWallet.deploy.decodeReceipt(factoryReceipt).value;

  const fundFactory = DevWallet.doAction.invocation(faucet.address, GAS_LIMIT, {
    invocationBytes: serialize(
      ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: factory,
        amount: CONTRACT_FUNDING * 10n,
      }),
      codec.Invocation,
    ),
  });
  await submit(client, faucet, fundFactory, []);

  const initializeFactory = DevWallet.doAction.invocation(
    alice.address,
    GAS_LIMIT,
    {
      invocationBytes: serialize(
        SwapFactory.initialize.invocation(factory, GAS_LIMIT, {
          hashes: {
            token: fixedBytes(tokenHash, 32),
            pair: fixedBytes(pairHash, 32),
            handler: fixedBytes(handlerHash, 32),
            driver: fixedBytes(driverHash, 32),
          },
          feeTo: null,
        }),
        codec.Invocation,
      ),
    },
  );
  await submit(client, alice, initializeFactory, []);

  // 5. Deploy and fund the router, then connect it to the initialized factory.
  const routerHash = hashContract(artifacts.router);
  const routerReceipt = await submit(
    client,
    alice,
    DevWallet.deploy.invocation(alice.address, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(routerHash, 32),
    }),
    [artifacts.router],
  );
  const router = DevWallet.deploy.decodeReceipt(routerReceipt).value;

  const fundRouter = DevWallet.doAction.invocation(faucet.address, GAS_LIMIT, {
    invocationBytes: serialize(
      ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
        receiver: router,
        amount: CONTRACT_FUNDING,
      }),
      codec.Invocation,
    ),
  });
  await submit(client, faucet, fundRouter, []);

  const initializeRouter = DevWallet.doAction.invocation(
    alice.address,
    GAS_LIMIT,
    {
      invocationBytes: serialize(
        SwapRouter.initialize.invocation(router, GAS_LIMIT, { factory }),
        codec.Invocation,
      ),
    },
  );
  await submit(client, alice, initializeRouter, []);

  // 6. Resolve the deterministic addresses the factory will use for this token
  // pair. Funding them now ensures they have HOG when the queued liquidity request
  // deploys or invokes them.
  const pool = (
    await SwapFactory.poolAddresses.view({
      client,
      contract: factory,
      caller: alice.address,
      args: { tokenA, tokenB },
    })
  ).value;

  for (const address of [
    pool.liquidity_token,
    pool.pair,
    pool.handler,
    pool.driver,
  ]) {
    const fundPoolContract = DevWallet.doAction.invocation(
      faucet.address,
      GAS_LIMIT,
      {
        invocationBytes: serialize(
          ERC20.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
            receiver: address,
            amount: CONTRACT_FUNDING,
          }),
          codec.Invocation,
        ),
      },
    );
    await submit(client, faucet, fundPoolContract, []);
  }

  // 7. Authorize the handler to consume exactly the amount of each token that will
  // be deposited as initial liquidity.
  for (const token of [tokenA, tokenB]) {
    const approveLiquidity = DevWallet.doAction.invocation(
      alice.address,
      GAS_LIMIT,
      {
        invocationBytes: serialize(
          ERC20.adjustAllowance.invocation(token, GAS_LIMIT, {
            spender: pool.handler,
            diff: LIQUIDITY_AMOUNT,
          }),
          codec.Invocation,
        ),
      },
    );
    await submit(client, alice, approveLiquidity, []);
  }

  // 8. Adding liquidity only queues a request. The separate driver call executes
  // it and transfers the approved token amounts into the pair.
  const addLiquidity = DevWallet.doAction.invocation(
    alice.address,
    GAS_LIMIT,
    {
      invocationBytes: serialize(
        SwapRouter.addLiquidity.invocation(router, GAS_LIMIT, {
          tokenA,
          tokenB,
          amountsDesired: [LIQUIDITY_AMOUNT, LIQUIDITY_AMOUNT],
          amountsMin: [0n, 0n],
          recipient: alice.address,
        }),
        codec.Invocation,
      ),
    },
  );
  await submit(client, alice, addLiquidity, []);

  const processRequests = DevWallet.doAction.invocation(
    alice.address,
    GAS_LIMIT,
    {
      invocationBytes: serialize(
        SwapDriver.processRequests.invocation(pool.driver, GAS_LIMIT),
        codec.Invocation,
      ),
    },
  );
  await submit(client, alice, processRequests, []);

  // 9. Confirm that queue processing produced the balanced pool expected by the
  // frontend. Swap behavior itself is covered by the live integration test.
  const [reserve0, reserve1] = (
    await SwapPair.getReserves.view({
      client,
      contract: pool.pair,
      caller: alice.address,
    })
  ).value;
  if (reserve0 !== LIQUIDITY_AMOUNT || reserve1 !== LIQUIDITY_AMOUNT) {
    throw new Error(
      `Expected initial reserves of ${LIQUIDITY_AMOUNT}; got ${reserve0} and ${reserve1}`,
    );
  }
  const liquidityBalances = await Promise.all(personas.map(async (persona) => (
    await ERC20.getBalanceOf.view({
      client,
      contract: pool.liquidity_token,
      caller: persona.account.address,
      args: { addr: persona.account.address },
    })
  ).value));
  if (liquidityBalances[0]! <= 0n || liquidityBalances.slice(1).some((balance) => balance !== 0n)) {
    throw new Error("Expected only Alice to receive the initial LP position");
  }

  return {
    personas,
    tokenA,
    tokenB,
    tokenC,
    factory,
    router,
    pool,
  };
}

async function submit(
  client: GroundhogClient,
  account: LocalDevAccount,
  invocation: Invocation,
  contractsToDeploy: Contract[],
): Promise<TransactionReceipt> {
  const tip = await client.getChainTip();
  const transaction = createTransaction({
    invocation,
    uniquifier: {
      block_expiry_height: blockHeight(tip.height + EXPIRY_BLOCKS),
      nonce: randomBytes(8).readBigUInt64BE(),
    },
    contracts_to_deploy: contractsToDeploy,
    auth_claim: {
      claim_type: AuthClaimType.kSourceAddressAuthData,
      source_address_claim: {
        allowed_keys: bitMap(1n),
        required_weight: weight(1n),
      },
    },
  });
  const signed = await signTransaction(transaction, [
    { signer: account.signer, publicKeyId: 0n },
  ]);
  const transactionHash = await client.sendTransaction(signed);
  const receipt = await client.waitForTransactionReceipt(transactionHash);
  if (receipt.execResult !== ExecResult.ExecResultOK) {
    throw new Error(`Transaction failed with result ${receipt.execResult}`);
  }
  return receipt;
}

async function loadArtifacts(root: string): Promise<Artifacts> {
  const contract = async (name: string): Promise<Contract> => ({
    contract_type: ContractType.kRv32,
    rv32_contract: { data: await readFile(join(root, name)) },
  });
  const [erc20, factory, router, handler, driver, pair] = await Promise.all([
    contract("erc20.rv32a"),
    contract("swap_factory.rv32a"),
    contract("swap_router.rv32a"),
    contract("swap_handler.rv32a"),
    contract("swap_driver.rv32a"),
    contract("swap_pair.rv32a"),
  ]);
  return { erc20, factory, router, handler, driver, pair };
}

function renderEnvironment(
  networkHash: string,
  rpcUrl: string,
  deployment: Deployment,
): string {
  return [
    `VITE_GROUNDHOG_RPC_URL=${rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${networkHash}`,
    `GROUNDHOG_DEV_PRIVATE_KEY=${deployment.personas[0]!.browserPrivateKey}`,
    `GROUNDHOG_DEV_PERSONAS=${JSON.stringify(deployment.personas.map((persona) => ({
      id: persona.id,
      label: persona.label,
      accountAddress: toHex0x(persona.account.address),
      privateKey: persona.browserPrivateKey,
    })))}`,
    `VITE_GROUNDHOG_WALLET_ADDRESS=${toHex0x(deployment.personas[0]!.account.address)}`,
    `VITE_GROUNDHOG_WALLET_ENTRYPOINT=${toHex0x(DevWallet.doAction.entrypoint)}`,
    `VITE_NATIVE_HOG_ADDRESS=${toHex0x(HOG_ADDRESS)}`,
    `VITE_SWAP_FACTORY_ADDRESS=${toHex0x(deployment.factory)}`,
    `VITE_SWAP_ROUTER_ADDRESS=${toHex0x(deployment.router)}`,
    `VITE_POOL_CONTRACT_FUNDING=${CONTRACT_FUNDING}`,
    `VITE_SWAP_PAIR_ADDRESS=${toHex0x(deployment.pool.pair)}`,
    `VITE_SWAP_LIQUIDITY_TOKEN_ADDRESS=${toHex0x(deployment.pool.liquidity_token)}`,
    `VITE_SWAP_HANDLER_ADDRESS=${toHex0x(deployment.pool.handler)}`,
    `VITE_SWAP_DRIVER_ADDRESS=${toHex0x(deployment.pool.driver)}`,
    `SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT=${toHex0x(SwapDriver.processRequests.entrypoint)}`,
    `VITE_TOKEN_A_ADDRESS=${toHex0x(deployment.tokenA)}`,
    `VITE_TOKEN_B_ADDRESS=${toHex0x(deployment.tokenB)}`,
    "VITE_TOKEN_A_SYMBOL=gUSD",
    "VITE_TOKEN_B_SYMBOL=gEUR",
    `VITE_TOKEN_DECIMALS=${TOKEN_DECIMALS}`,
    "",
  ].join("\n");
}

function renderCliConfig(
  networkHash: string,
  rpcUrl: string,
  manifestPath: string,
  keyName: string,
): string {
  return `# generated_network_id = ${networkHash}\n${stringify({
    default_key: keyName,
    default_profile: "local",
    profile: {
      local: {
        network: "local",
        rpc_url: rpcUrl,
        runtime_manifest: manifestPath,
      },
    },
  })}`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
