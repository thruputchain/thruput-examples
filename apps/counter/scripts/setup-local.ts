import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  deriveContractAddress,
  fixedBytes,
  fromHex0x,
  hashContract,
  HttpTransport,
  localnet,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { DefaultWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  ExecResult,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
  type Invocation,
} from "@groundhogchain/protocol";
import { hex32, parseHttpUrl } from "../src/config";
import { Counter } from "../src/contracts/generated/counter";
import { loadServerConfig } from "../server/config";
import { parseEnv } from "node:util";

const INITIAL_VALUE = 1_000_000n;
const GAS = gasAmount(10_000_000n);

export async function setup(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const output = resolve(
    env.COUNTER_APP_ENV ??
      fileURLToPath(new URL("../.env.local", import.meta.url)),
  );
  const url = parseHttpUrl(env.GROUNDHOG_RPC_URL ?? "http://127.0.0.1:9545");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Local setup requires a loopback HTTP RPC URL.");
  }
  if (!env.GROUNDHOG_RUNTIME_MANIFEST)
    throw new Error(
      "Set GROUNDHOG_RUNTIME_MANIFEST to the node's runtime manifest.",
    );
  const manifest: { networkHash?: unknown } = JSON.parse(
    await readFile(env.GROUNDHOG_RUNTIME_MANIFEST, "utf8"),
  );
  const networkId = hex32(manifest.networkHash, "Runtime network hash");
  const client = await createGroundhogClient({
    cluster: localnet({
      rpcUrl: url.href,
      networkHash: networkHash(sha256Hash(fromHex0x(networkId))),
    }),
    transport: new HttpTransport(url.href, { timeoutMs: 10_000 }),
  });
  // Reruns verify the existing deployment. initialize() is additive, not a reset.
  try {
    const existing = loadServerConfig(parseEnv(await readFile(output, "utf8")));
    if (existing.app.networkId !== networkId || existing.rpcUrl !== url.href) {
      throw new Error(
        "Existing configuration belongs to another node. Choose a new COUNTER_APP_ENV path.",
      );
    }
    const { createCounterConnection } = await import("../src/groundhog/client");
    const connection = await createCounterConnection(existing.app, url.href);
    try {
      await connection.read();
    } finally {
      connection.dispose();
    }
    console.log(`Existing counter verified. App environment: ${output}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const data = await readFile(
    env.COUNTER_ARTIFACT ??
      fileURLToPath(
        new URL("../../../target/groundhog/counter.rv32a", import.meta.url),
      ),
  );
  const contract = {
    contract_type: ContractType.kRv32 as const,
    rv32_contract: { data },
  };
  const signerBytes = randomBytes(32);
  const account = createPubkeyAccount({
    signer: new PrivateKeySigner(signerBytes),
  });
  const wallet = createWalletClient({ client, account });
  const nonce = sha256Hash(randomBytes(32));
  const codeHash = hashContract(contract);
  const address = deriveContractAddress(account.address, nonce, codeHash);
  const execute = async (invocation: Invocation) => {
    const hash = await wallet.execute({ invocation, gasLimit: GAS });
    const receipt = await wallet.waitForTransactionReceipt(hash);
    if (receipt.execResult !== ExecResult.ExecResultOK)
      throw new Error(
        `Setup transaction failed: ${ExecResult[receipt.execResult]}`,
      );
  };
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    const airdrop = await wallet.requestAirdrop();
    if (airdrop.status.result !== "ok")
      throw new Error("Development account funding failed.");
    await execute(
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
    const receipt = await wallet.waitForTransactionReceipt(hash);
    if (
      receipt.execResult !== ExecResult.ExecResultOK ||
      !bytesEqual(DefaultWallet.deploy.decodeReceipt(receipt).value, address)
    ) {
      throw new Error("Counter deployment failed.");
    }
    await execute(
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
        `VITE_GROUNDHOG_RPC_URL=${url.href}`,
        `VITE_GROUNDHOG_NETWORK_ID=${networkId}`,
        `VITE_COUNTER_ADDRESS=${toHex0x(address)}`,
        `COUNTER_DEVELOPMENT_PRIVATE_KEY=${toHex0x(signerBytes)}`,
        "VITE_EXPLORER_URL=",
        "",
      ].join("\n"),
    );
    // Publish only a complete setup; never overwrite another invocation's config.
    await link(temporary, output);
    console.log(
      `Counter ready at ${toHex0x(address)}\nDevelopment account: ${toHex0x(account.address)}\nApp environment: ${output}`,
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setup().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Setup failed.");
    process.exitCode = 1;
  });
}
