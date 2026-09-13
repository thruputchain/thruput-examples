import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  deriveContractAddress,
  fixedBytes,
  fromHex0x,
  hashContract,
  HttpTransport,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { DefaultWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  ExecResult,
  gasAmount,
  networkHash,
  sha256Hash,
  HOG_ADDRESS,
  type Invocation,
} from "@groundhogchain/protocol";
import { parseConfig } from "../src/config";
import { Counter } from "../src/contracts/generated/counter";

const GAS = gasAmount(10_000_000n);
const INITIAL_VALUE = 1_000_000n;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Create a fresh disposable counter and publish its environment on success. */
export async function provisionCounter(options: {
  network: "local" | "devnet";
  rpcUrl: string;
  networkId: string;
  output: string;
  artifact?: string | undefined;
  explorerUrl?: string | undefined;
}): Promise<void> {
  const client = await createGroundhogClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl: options.rpcUrl,
      networkHash: networkHash(sha256Hash(fromHex0x(options.networkId))),
      capabilities: ["airdrop"] as const,
    }),
    transport: new HttpTransport(options.rpcUrl, { timeoutMs: 15_000 }),
  });
  const version = await client.getVersion();
  if (
    !/^(?:[4-9]|[1-9]\d+)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      version.wireFormat,
    )
  ) {
    throw new Error(
      `RPC wire format >=4.0.0 is required; found ${version.wireFormat}`,
    );
  }
  const contract = {
    contract_type: ContractType.kRv32 as const,
    rv32_contract: {
      data: await readFile(
        resolve(
          repositoryRoot,
          options.artifact || "target/groundhog/counter.rv32a",
        ),
      ),
    },
  };
  const key = randomBytes(32);
  const account = createPubkeyAccount({ signer: new PrivateKeySigner(key) });
  const wallet = createWalletClient({ client, account });
  const codeHash = hashContract(contract);
  const nonce = sha256Hash(randomBytes(32));
  const address = deriveContractAddress(account.address, nonce, codeHash);
  const config = parseConfig({
    networkId: options.networkId,
    counterAddress: toHex0x(address),
    signerAddress: toHex0x(account.address),
    explorerUrl: options.explorerUrl,
  });
  const execute = async (name: string, invocation: Invocation) => {
    const hash = await wallet.execute({ invocation, gasLimit: GAS });
    console.log(`${name}: ${toHex0x(hash)}`);
    const receipt = await wallet.waitForTransactionReceipt(hash, {
      timeoutMs: 60_000,
    });
    if (receipt.execResult !== ExecResult.ExecResultOK)
      throw new Error(`${name} failed: ${ExecResult[receipt.execResult]}`);
  };
  const output = resolve(repositoryRoot, options.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    const funding = await wallet.requestAirdrop();
    if (funding.status.result !== "ok")
      throw new Error("Counter signer funding failed.");
    console.log(`Airdrop confirmed: ${funding.rawAmount} raw HOG (7 decimals)`);
    await execute(
      "Fund counter",
      ERC20.transfer.invocation(HOG_ADDRESS, GAS, {
        receiver: address,
        amount: 10_000_000n,
      }),
    );
    const hash = await wallet.sendInvocation({
      invocation: DefaultWallet.deploy.invocation(account.address, GAS, {
        nonce: fixedBytes(nonce, 32),
        contractHash: fixedBytes(codeHash, 32),
      }),
      contractsToDeploy: [contract],
    });
    console.log(`Deploy counter: ${toHex0x(hash)}`);
    const receipt = await wallet.waitForTransactionReceipt(hash, {
      timeoutMs: 60_000,
    });
    if (
      receipt.execResult !== ExecResult.ExecResultOK ||
      !bytesEqual(DefaultWallet.deploy.decodeReceipt(receipt).value, address)
    ) {
      throw new Error("Counter deployment failed.");
    }
    await execute(
      "Initialize counter",
      Counter.initialize.invocation(address, GAS, {
        initialValue: INITIAL_VALUE,
      }),
    );
    if (
      (
        await Counter.get.view({
          client,
          contract: address,
          caller: account.address,
        })
      ).value !== INITIAL_VALUE
    ) {
      throw new Error("Counter initialization could not be verified.");
    }
    await writeFile(
      temporary,
      [
        `VITE_GROUNDHOG_RPC_URL=${options.rpcUrl}`,
        `VITE_GROUNDHOG_NETWORK_ID=${config.networkId}`,
        `VITE_COUNTER_ADDRESS=${config.counterAddress}`,
        `COUNTER_SIGNING_PRIVATE_KEY=${toHex0x(key)}`,
        `VITE_EXPLORER_URL=${config.explorerUrl ?? ""}`,
        "PORT=3000",
        "",
      ].join("\n"),
    );
    await rename(temporary, output);
    console.log(
      `Counter ready at ${config.counterAddress}\nSigner: ${config.signerAddress}\nEnvironment: ${output}`,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
