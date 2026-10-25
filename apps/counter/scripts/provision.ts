import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  Ed25519Signer,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { prepareContractDeployment } from "@thruputchain/client/wallet";
import {
  gasAmount,
  networkHash,
  NATIVE_TOKEN_ADDRESS,
  type Invocation,
} from "@thruputchain/protocol";
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
  const client = await createThruputClient({
    cluster: defineCluster({
      name: options.network,
      rpcUrl: options.rpcUrl,
      networkHash: networkHash(hashFromBase58(options.networkId)),
      capabilities: ["airdrop"] as const,
    }),
    transport: new HttpTransport(options.rpcUrl, { timeoutMs: 15_000 }),
  });
  const version = await client.getVersionInfo();
  if (!/^14\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version.wireFormat)) {
    throw new Error(
      `RPC wire format 14.x is required; found ${version.wireFormat}`,
    );
  }
  const contract = await readFile(
    resolve(repositoryRoot, options.artifact || "target/thruput/counter.rv32a"),
  );
  const key = randomBytes(32);
  const account = createPubkeyAccount({ signer: new Ed25519Signer(key) });
  const wallet = createWalletClient({ client, account });
  const deployment = prepareContractDeployment({
    deployer: account.address,
    contract,
  });
  const address = deployment.address;
  const config = parseConfig({
    networkId: options.networkId,
    counterAddress: toBase58(address),
    signerAddress: toBase58(account.address),
    explorerUrl: options.explorerUrl,
  });
  const execute = async (name: string, invocation: Invocation) => {
    const { transactionHash: txHash } = await wallet.executeAndWait(
      { invocation, gasLimit: GAS },
      { timeoutMs: 60_000 },
    );
    console.log(`${name}: ${toBase58(txHash)}`);
  };
  const output = resolve(repositoryRoot, options.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    const funding = await wallet.requestAirdrop();
    console.log(`Airdrop confirmed: ${funding.rawAmount} raw native-token units (7 decimals)`);
    await execute(
      "Fund counter",
      ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, GAS, {
        receiver: address,
        amount: 10_000_000n,
      }),
    );
    const { transactionHash: txHash } = await wallet.deployContractAndWait(
      deployment,
      { gasLimit: GAS, amount: 0n },
      {
        timeoutMs: 60_000,
      },
    );
    console.log(`Deploy counter: ${toBase58(txHash)}`);
    await execute(
      "Initialize counter",
      Counter.v0_1.initialize.invocation(address, GAS, {
        initialValue: INITIAL_VALUE,
      }),
    );
    if (
      (
        await Counter.v0_1.get.view({
          client,
          address: address,
          caller: account.address,
        })
      ).value !== INITIAL_VALUE
    ) {
      throw new Error("Counter initialization could not be verified.");
    }
    await writeFile(
      temporary,
      [
        `VITE_THRUPUT_RPC_URL=${options.rpcUrl}`,
        `VITE_THRUPUT_NETWORK_ID=${config.networkId}`,
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
