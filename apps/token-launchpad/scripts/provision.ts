import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bytesEqual,
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  fixedBytes,
  fromHex0x,
  hashContract,
  HttpTransport,
  PrivateKeySigner,
  toHex0x,
} from "@thruputchain/client";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@thruputchain/protocol";

import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "../src/contracts/generated/standard-token-factory";
import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../src/thruput/storage-cost";
import { parseExplorerUrl } from "../src/lib/explorer-url";

type FactoryConfig = standard_token_factory_if.v0_1.factory.FactoryConfig;

const GAS_LIMIT = gasAmount(10_000_000n);
const CONTRACT_FUNDING = 10_000_000n;
const TOKEN_INITIALIZATION_BUDGET = 370_000n;
// Leave storage reserve for allowance and recipient rows after initialization.
const REQUIRED_TOKEN_FUNDING = 1_000_000n;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function provisionLaunchpad(options: {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId: string;
  output: string;
  storageCosts?: unknown;
  artifactRoot?: string | undefined;
  publicDirectory?: string | undefined;
  explorerUrl?: string | undefined;
}): Promise<void> {
  const artifactRoot = resolve(
    repositoryRoot,
    options.artifactRoot || "target/thruput",
  );
  const environmentPath = resolve(repositoryRoot, options.output);
  const artifactDirectory = join(
    resolve(
      repositoryRoot,
      options.publicDirectory ||
        fileURLToPath(new URL("../public", import.meta.url)),
    ),
    "contract-artifacts",
  );
  const rpcUrl = options.rpcUrl;
  const expectedNetwork = networkHash(sha256Hash(fromHex0x(options.networkId)));
  const explorerUrl = parseExplorerUrl(options.explorerUrl);
  const requiredTokenFunding =
    options.network === "devnet" ? CONTRACT_FUNDING : REQUIRED_TOKEN_FUNDING;
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl,
      networkHash: expectedNetwork,
      capabilities: ["airdrop"] as const,
    }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
  const version = await client.getVersion();
  if (
    !/^(?:[4-9]|[1-9]\d+)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      version.wireFormat,
    )
  ) {
    throw new Error(
      `Thruput wire format >=4.0.0 is required; found ${version.wireFormat}`,
    );
  }
  const [tokenContract, factoryContract] = await Promise.all(
    ["standard_token", "standard_token_factory"].map(
      async (name): Promise<Contract> => ({
        contract_type: ContractType.kRv32,
        rv32_contract: {
          data: await readFile(join(artifactRoot, `${name}.rv32a`)),
        },
      }),
    ),
  );
  const tokenHash = hashContract(tokenContract!);
  const artifactPath = join(artifactDirectory, `${toHex0x(tokenHash)}.json`);
  if (tokenContract?.contract_type !== ContractType.kRv32)
    throw new Error("Expected an RV32 token artifact");
  if (options.network === "local")
    validateTokenFunding(
      options.storageCosts,
      tokenContract.rv32_contract.data.length,
    );
  const artifactContents = `${JSON.stringify({ contractType: "rv32", data: toHex0x(tokenContract.rv32_contract.data), hash: toHex0x(tokenHash) })}\n`;

  // Tool-only deployer: never export the key or account to browser configuration.
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  const execute = async (invocation: Invocation): Promise<void> => {
    const { txHash } = await wallet.executeAndWait(
      { invocation, gasLimit: GAS_LIMIT },
      { timeoutMs: 60_000 },
    );
    console.log(`Setup transaction: ${toHex0x(txHash)}`);
  };

  await mkdir(dirname(environmentPath), { recursive: true });
  await mkdir(dirname(artifactPath), { recursive: true });
  const temporary = `${environmentPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const temporaryArtifact = `${artifactPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await writeFile(temporaryArtifact, artifactContents, {
      mode: 0o644,
      flag: "wx",
    });
    const airdrop = await wallet.requestAirdrop();
    if (
      airdrop.status.result !== "ok" ||
      (await wallet.getBalance()).rawBalance < CONTRACT_FUNDING * 3n
    ) {
      throw new Error(
        "Infrastructure deployer airdrop did not provide the required HOG reserve",
      );
    }
    console.log(`Airdrop confirmed: ${airdrop.rawAmount} raw HOG (7 decimals)`);
    // Unused contractsToDeploy attachments are not persisted by the node.
    // The first user token creation must attach standard_token.rv32a; setup
    // deliberately does not instantiate a token just to register its code.
    const deployment = prepareContractDeployment({
      deployer: account.address,
      contract: factoryContract!,
    });
    const predicted = deployment.address;
    // DefaultWallet.v0_1.deploy does not fund the deployment's storage automatically.
    for (const receiver of [HOG_ADDRESS, predicted]) {
      await execute(
        ERC20.v0_1.transfer.invocation(HOG_ADDRESS, GAS_LIMIT, {
          receiver,
          amount: CONTRACT_FUNDING,
        }),
      );
    }
    if (options.network === "devnet") {
      // A fresh address has only its native balance row at this point. Check
      // the bookkeeping charge used by the frontend's token prefunding flow.
      const received = (await wallet.getBalance(predicted)).rawBalance;
      if (CONTRACT_FUNDING - received !== PINNED_NATIVE_BALANCE_ITEM_COST) {
        throw new Error(
          "Devnet native balance bookkeeping cost could not be verified against the app's pinned runtime",
        );
      }
    }
    const { txHash, address: factoryAddress } =
      await wallet.deployContractAndWait(deployment, { gasLimit: GAS_LIMIT, amount: 0n }, {
        timeoutMs: 60_000,
      });
    console.log(`Deploy token factory: ${toHex0x(txHash)}`);
    const expectedConfig: FactoryConfig = {
      token_code_hash: fixedBytes(tokenHash, 32),
      required_token_funding: requiredTokenFunding,
      native_token: HOG_ADDRESS,
      creation_fee: 0n,
      fee_recipient: null,
    };
    await execute(
      StandardTokenFactory.v0_1.initialize.invocation(factoryAddress, GAS_LIMIT, {
        config: expectedConfig,
      }),
    );
    const observed = (
      await StandardTokenFactory.v0_1.config.view({
        client,
        contract: factoryAddress,
        caller: account.address,
      })
    ).value;
    if (
      !bytesEqual(observed.token_code_hash, tokenHash) ||
      observed.required_token_funding !== requiredTokenFunding ||
      !bytesEqual(observed.native_token, HOG_ADDRESS) ||
      observed.creation_fee !== 0n ||
      observed.fee_recipient !== null
    ) {
      throw new Error(
        "The deployed factory configuration could not be verified",
      );
    }
    await writeFile(
      temporary,
      renderEnvironment({
        rpcUrl,
        networkHash: toHex0x(expectedNetwork),
        factoryAddress,
        tokenHash,
      }) +
        (options.network === "devnet"
          ? [
              `VITE_EXPLORER_URL=${explorerUrl ?? ""}`,
              "VITE_SWAP_APP_URL=",
              "PORT=3000",
              "",
            ].join("\n")
          : ""),
    );
    // Publish complete code bytes before the environment completion marker.
    await publishArtifact(temporaryArtifact, artifactPath);
    await rename(temporary, environmentPath);
    console.log(
      `Launchpad ${options.network} infrastructure ready\nApp environment: ${environmentPath}\nFactory: ${toHex0x(factoryAddress)}\nToken code: ${toHex0x(tokenHash)}\nRequired token funding: ${requiredTokenFunding}`,
    );
    console.warn(
      `No tokens were created. First token creation can attach the code asset at ${artifactPath}.`,
    );
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryArtifact, { force: true });
  }
}

function renderEnvironment(input: {
  rpcUrl: string;
  networkHash: string;
  factoryAddress: ContractAddress;
  tokenHash: Uint8Array;
}): string {
  return [
    `VITE_THRUPUT_RPC_URL=${input.rpcUrl}`,
    `VITE_THRUPUT_NETWORK_ID=${input.networkHash}`,
    `VITE_NATIVE_HOG_ADDRESS=${toHex0x(HOG_ADDRESS)}`,
    `VITE_NATIVE_BALANCE_ITEM_COST=${PINNED_NATIVE_BALANCE_ITEM_COST}`,
    `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toHex0x(input.factoryAddress)}`,
    `VITE_STANDARD_TOKEN_HASH=${toHex0x(input.tokenHash)}`,
    "",
  ].join("\n");
}

export function validateTokenFunding(
  costs: unknown,
  artifactBytes: number,
): void {
  // Same storage profile as the legacy local-environment validator, without
  // any bootstrap-account or persona requirements.
  const profile = {
    hash: "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce",
    baseDataItemCost: "12000",
    bytestringCostPerByte: "10",
    baseContractDeploymentCost: "12000",
    contractDeploymentCostPerByte: "10",
    authPerKeyCost: "1111",
    rcqCostPerEntry: "8",
    replayCacheCostPerEntry: "7",
    balanceCost: PINNED_NATIVE_BALANCE_ITEM_COST.toString(),
  };
  if (typeof costs !== "object" || costs === null)
    throw new Error("Runtime manifest must include storageCostModel");
  for (const [field, expected] of Object.entries(profile)) {
    const actual = (costs as Record<string, unknown>)[field];
    if (actual !== expected)
      throw new Error(`Unsupported runtime storage cost: ${field}`);
  }
  // initialize_once writes Config and at most holder + total_supply NNInt rows.
  // Config's conservative XDR bound is 168 bytes: address 32, optional name
  // (100 bytes) 108, optional symbol (10 bytes padded to 12) 20, decimals 8.
  // Include native balance bookkeeping as well. No token auth/RCQ/replay rows
  // are created: the factory invokes the initializer as a nested call.
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0)
    throw new Error("Invalid token artifact size");
  const maximumCost =
    12_000n +
    BigInt(artifactBytes) * 10n +
    12_000n +
    168n * 10n +
    2n * 12_000n +
    PINNED_NATIVE_BALANCE_ITEM_COST;
  if (maximumCost > TOKEN_INITIALIZATION_BUDGET) {
    throw new Error(
      `Token artifact exceeds the ${TOKEN_INITIALIZATION_BUDGET} deployment/initialization funding budget`,
    );
  }
}

export async function publishArtifact(
  temporary: string,
  destination: string,
): Promise<void> {
  try {
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!bytesEqual(await readFile(temporary), await readFile(destination))) {
      throw new Error("Existing hash-named artifact has different contents");
    }
  }
}
