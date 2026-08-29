import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  bytesEqual,
  createGroundhogClient,
  createSourceAddressAccount,
  createWalletClient,
  devWalletAdapter,
  fixedBytes,
  hashContract,
  HttpTransport,
  localnet,
  PrivateKeySigner,
  toHex0x,
  type ConnectedGroundhogClient,
  type ExecutableWalletClient,
  type SourceAddressAccount,
} from "@groundhogchain/client";
import { DevWallet } from "@groundhogchain/client/contracts";
import { loadLocalDevAccount } from "@groundhogchain/client/local-dev";
import {
  bitMap,
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  sha256Hash,
  weight,
  type Contract,
  type ContractAddress,
  type Invocation,
} from "@groundhogchain/protocol";

import {
  StandardTokenFactory,
  type FactoryConfig,
} from "../src/contracts/generated/standard-token-factory";
import {
  renderEnvironment,
  REQUIRED_TOKEN_FUNDING,
  validateLocalRpcUrl,
  validateRuntimeManifest,
  validateWireFormat,
  type EnvironmentPersona,
  type RuntimeManifest,
} from "../src/setup/local-environment";

const GAS_LIMIT = gasAmount(100_000_000n);
const PERSONAS = [
  { id: "alice", label: "Alice" },
  { id: "bob", label: "Bob" },
  { id: "carol", label: "Carol" },
] as const;

async function main(): Promise<void> {
  const manifestPath = resolve(
    requiredEnvironment("GROUNDHOG_RUNTIME_MANIFEST"),
  );
  const artifactRoot = resolve(requiredEnvironment("LAUNCHPAD_ARTIFACT_ROOT"));
  const environmentPath = resolve(requiredEnvironment("LAUNCHPAD_APP_ENV"));
  const rpcUrl = validateLocalRpcUrl(requiredEnvironment("GROUNDHOG_RPC_URL"));
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as RuntimeManifest;
  validateRuntimeManifest(manifest);

  const client = await createGroundhogClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
  const version = await client.getVersion();
  validateWireFormat(version.wireFormat);

  const personas = await Promise.all(
    PERSONAS.map(async (identity, roleOffset): Promise<EnvironmentPersona> => {
      const local = await loadLocalDevAccount({
        role: "local_user",
        roleOffset,
      });
      const recorded = manifest.bootstrapAccounts.find(
        ({ index }) => index === local.index,
      );
      if (
        recorded?.role !== "local_user" ||
        recorded.walletAddress !== toHex0x(local.address)
      ) {
        throw new Error(
          `${identity.label}'s account does not match the runtime manifest`,
        );
      }
      const privateKey = createHash("sha256")
        .update(
          `${manifest.bootstrapAccountDerivation.seed}:account-${local.index}`,
        )
        .digest();
      if (
        !bytesEqual(
          new PrivateKeySigner(privateKey).publicKey.ed25519,
          hexBytes(recorded.publicKey),
        )
      ) {
        throw new Error(
          `${identity.label}'s key does not match the runtime manifest`,
        );
      }
      return {
        ...identity,
        accountAddress: toHex0x(local.address),
        privateKey: toHex0x(privateKey),
      };
    }),
  );

  const alice = await loadLocalDevAccount({
    role: "local_user",
    roleOffset: 0,
  });
  const account = createSourceAddressAccount({
    address: alice.address,
    signers: [{ signer: alice.signer, publicKeyId: 0n }],
    allowedKeys: bitMap(1n),
    requiredWeight: weight(1n),
  });
  const wallet = createWalletClient({
    client,
    account,
    invocationAdapter: devWalletAdapter,
  });
  const [tokenContract, factoryContract] = await Promise.all([
    loadContract(join(artifactRoot, "standard_token.rv32a")),
    loadContract(join(artifactRoot, "standard_token_factory.rv32a")),
  ]);
  const tokenHash = hashContract(tokenContract);

  await deploy(wallet, alice.address, tokenHash, tokenContract);
  const factoryHash = hashContract(factoryContract);
  const factoryAddress = await deploy(
    wallet,
    alice.address,
    factoryHash,
    factoryContract,
  );
  const expectedConfig: FactoryConfig = {
    token_code_hash: fixedBytes(tokenHash, 32),
    required_token_funding: REQUIRED_TOKEN_FUNDING,
    native_token: HOG_ADDRESS,
    creation_fee: 0n,
    fee_recipient: null,
  };
  await execute(
    wallet,
    StandardTokenFactory.initialize.invocation(factoryAddress, GAS_LIMIT, {
      config: expectedConfig,
    }),
  );
  const observed = (
    await StandardTokenFactory.config.view({
      client,
      contract: factoryAddress,
      caller: alice.address,
    })
  ).value;
  if (
    !bytesEqual(observed.token_code_hash, tokenHash) ||
    observed.required_token_funding !== REQUIRED_TOKEN_FUNDING ||
    !bytesEqual(observed.native_token, HOG_ADDRESS) ||
    observed.creation_fee !== 0n ||
    observed.fee_recipient !== null
  ) {
    throw new Error("The deployed factory configuration could not be verified");
  }

  await publishEnvironment(
    environmentPath,
    renderEnvironment({
      rpcUrl,
      networkHash: manifest.networkHash,
      walletEntrypoint: toHex0x(DevWallet.doAction.entrypoint),
      nativeHogAddress: HOG_ADDRESS,
      factoryAddress,
      tokenHash,
      personas,
    }),
  );
  console.log(
    `Local launchpad setup complete\nApp environment: ${environmentPath}\nFactory: ${toHex0x(factoryAddress)}`,
  );
}

async function deploy(
  wallet: SetupWallet,
  owner: ContractAddress,
  contractHash: ReturnType<typeof hashContract>,
  contract: Contract,
): Promise<ContractAddress> {
  const hash = await wallet.sendInvocation({
    invocation: DevWallet.deploy.invocation(owner, GAS_LIMIT, {
      nonce: fixedBytes(sha256Hash(randomBytes(32)), 32),
      contractHash: fixedBytes(contractHash, 32),
    }),
    contractsToDeploy: [contract],
  });
  const receipt = await wallet.waitForTransactionReceipt(hash);
  requireSuccess(receipt.execResult);
  return DevWallet.deploy.decodeReceipt(receipt).value;
}

async function execute(
  wallet: SetupWallet,
  invocation: Invocation,
): Promise<void> {
  const hash = await wallet.execute({ invocation, gasLimit: GAS_LIMIT });
  const receipt = await wallet.waitForTransactionReceipt(hash);
  requireSuccess(receipt.execResult);
}

type SetupWallet = ExecutableWalletClient<
  ConnectedGroundhogClient,
  SourceAddressAccount
>;

function requireSuccess(result: ExecResult): void {
  if (result !== ExecResult.ExecResultOK) {
    throw new Error(`Setup transaction failed with ${ExecResult[result]}`);
  }
}

async function loadContract(path: string): Promise<Contract> {
  return {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: await readFile(path) },
  };
}

async function publishEnvironment(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hexBytes(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("The runtime manifest contains an invalid public key");
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
