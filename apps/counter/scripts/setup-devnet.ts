import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bytesEqual,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  deriveContractAddress,
  devnet,
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
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
  type Invocation,
} from "@groundhogchain/protocol";
import {
  durableMkdir,
  executeStep,
  saveJson,
  SeedError,
  type SeedJournal,
} from "../../../scripts/seed/seed-journal.ts";
import { hex32, parseHttpUrl } from "../src/config";
import { Counter } from "../src/contracts/generated/counter";

interface Deployment extends SeedJournal {
  version: 1;
  networkId: string;
  codeHash: string;
  privateKey: string;
  deploymentNonce: string;
  airdropNonce: string;
  funded: boolean;
  verified: boolean;
}

const GAS = gasAmount(10_000_000n);
const INITIAL_VALUE = 1_000_000n;

export async function setupDevnet(
  env: Record<string, string | undefined> = process.env,
) {
  if (!env.GROUNDHOG_NETWORK_ID) {
    throw new SeedError(
      "Set GROUNDHOG_NETWORK_ID to the live Devnet network hash before deploying.",
    );
  }
  const rpcUrl = parseHttpUrl(
    env.GROUNDHOG_RPC_URL ?? "https://rpc.thruput.network",
  );
  if (rpcUrl.protocol !== "https:")
    throw new SeedError("Devnet deployment requires HTTPS.");
  const networkId = hex32(env.GROUNDHOG_NETWORK_ID, "GROUNDHOG_NETWORK_ID");
  const client = await createGroundhogClient({
    cluster: devnet({
      rpcUrl: rpcUrl.href,
      networkHash: networkHash(sha256Hash(fromHex0x(networkId))),
    }),
    transport: new HttpTransport(rpcUrl.href, { timeoutMs: 15_000 }),
  });
  const version = await client.getVersion();
  if (!version.wireFormat.startsWith("5."))
    throw new SeedError("This deployment script expects RPC wire format 5.x.");
  const contract = {
    contract_type: ContractType.kRv32 as const,
    rv32_contract: {
      data: await readFile(
        env.COUNTER_ARTIFACT ??
          fileURLToPath(
            new URL("../../../target/groundhog/counter.rv32a", import.meta.url),
          ),
      ),
    },
  };
  const codeHash = hashContract(contract);
  const directory = resolve(
    env.COUNTER_DEPLOYMENT_DIR ??
      fileURLToPath(
        new URL(`../.local/devnet/${networkId.slice(2)}`, import.meta.url),
      ),
  );
  await durableMkdir(directory);
  const lockPath = join(directory, "deployment.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST")
        throw new SeedError(
          `Cannot create the deployment lock in ${directory}. Check directory permissions.`,
        );
      throw new SeedError(
        `Deployment is locked. Check for another deployment process before removing ${lockPath}`,
      );
    },
  );
  try {
    await lock.writeFile(String(process.pid));
    const statePath = join(directory, "deployment.json");
    let state: Deployment;
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as Deployment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SeedError(
          "Cannot read deployment state. Preserve it and investigate before retrying.",
        );
      state = {
        version: 1,
        networkId,
        codeHash: toHex0x(codeHash),
        privateKey: toHex0x(randomBytes(32)),
        deploymentNonce: toHex0x(randomBytes(32)),
        airdropNonce: toHex0x(randomBytes(16)),
        funded: false,
        verified: false,
        steps: {},
      };
      await saveJson(statePath, state);
    }
    if (
      state.version !== 1 ||
      state.networkId !== networkId ||
      state.codeHash !== toHex0x(codeHash)
    ) {
      throw new SeedError(
        "Deployment state belongs to another network or contract build. Use a separate COUNTER_DEPLOYMENT_DIR for a new deployment.",
      );
    }
    const save = () => saveJson(statePath, state);
    const account = createPubkeyAccount({
      signer: new PrivateKeySigner(
        fromHex0x(hex32(state.privateKey, "Saved signing key")),
      ),
    });
    const wallet = createWalletClient({ client, account });
    const nonce = sha256Hash(
      fromHex0x(hex32(state.deploymentNonce, "Saved deployment nonce")),
    );
    const address = deriveContractAddress(account.address, nonce, codeHash);
    console.log(
      `Devnet signer: ${toHex0x(account.address)}\nCounter address: ${toHex0x(address)}`,
    );

    if (!state.funded) {
      const deadline = Date.now() + 90_000;
      while (true) {
        const result = await client.requestAirdropAttempt({
          recipient: account.address,
          clientNonce: fromHex0x(state.airdropNonce),
        });
        if (!bytesEqual(result.recipient, account.address)) {
          throw new SeedError("Funding response belongs to another recipient.");
        }
        if (result.attemptStatus === "succeeded") {
          if (result.status.result !== "ok")
            throw new SeedError("Devnet funding did not execute successfully.");
          state.funded = true;
          await save();
          console.log(`Signer funded: ${toHex0x(result.txHash)}`);
          break;
        }
        if (Date.now() >= deadline)
          throw new SeedError(
            "Funding is still pending. Rerun with the same deployment directory to resume.",
          );
        await new Promise((done) =>
          setTimeout(
            done,
            Math.max(250, Math.min(result.retryAfterSeconds * 1_000, 5_000)),
          ),
        );
      }
    }
    const execute = async (name: string, invocation: Invocation) => {
      const receipt = await executeStep({
        name,
        intent: `${networkId}:${toHex0x(address)}:${name}`,
        journal: state,
        save,
        client,
        retryFailed: env.SEED_RETRY_FAILED === "1",
        prepare: async () =>
          wallet.signTransaction(
            await wallet.prepareExecution({
              invocation,
              gasLimit: GAS,
              expiryBlocks: 1_000n,
            }),
          ),
      });
      console.log(`${name}: ${toHex0x(receipt.txHash)}`);
      return receipt;
    };
    await execute(
      "fund-counter",
      ERC20.transfer.invocation(HOG_ADDRESS, GAS, {
        receiver: address,
        amount: 10_000_000n,
      }),
    );
    const deployed = await executeStep({
      name: "deploy",
      intent: `${networkId}:${toHex0x(address)}:${state.codeHash}`,
      journal: state,
      save,
      client,
      retryFailed: env.SEED_RETRY_FAILED === "1",
      prepare: async () =>
        wallet.signTransaction(
          await wallet.prepareTransaction({
            invocation: DefaultWallet.deploy.invocation(account.address, GAS, {
              nonce: fixedBytes(nonce, 32),
              contractHash: fixedBytes(codeHash, 32),
            }),
            contractsToDeploy: [contract],
            expiryBlocks: 1_000n,
          }),
        ),
    });
    if (
      !bytesEqual(DefaultWallet.deploy.decodeReceipt(deployed).value, address)
    )
      throw new SeedError(
        "Deployed address does not match the funded address.",
      );
    console.log(`deploy: ${toHex0x(deployed.txHash)}`);
    await execute(
      "initialize",
      Counter.initialize.invocation(address, GAS, {
        initialValue: INITIAL_VALUE,
      }),
    );
    await execute(
      "verify-increment",
      Counter.increment.invocation(address, GAS, { amount: 1n }),
    );
    await execute(
      "verify-decrement",
      Counter.decrement.invocation(address, GAS, { amount: 1n }),
    );
    const view = await Counter.get.view({
      client,
      contract: address,
      caller: account.address,
    });
    if (!state.verified && view.value !== INITIAL_VALUE)
      throw new SeedError(
        "Counter value did not match the initialized value after verification.",
      );
    state.verified = true;
    await save();

    const environmentPath = join(directory, "railway.env");
    const temporary = `${environmentPath}.tmp`;
    try {
      await writeFile(
        temporary,
        [
          `VITE_GROUNDHOG_RPC_URL=${rpcUrl.href}`,
          `VITE_GROUNDHOG_NETWORK_ID=${networkId}`,
          `VITE_COUNTER_ADDRESS=${toHex0x(address)}`,
          `COUNTER_SIGNING_PRIVATE_KEY=${state.privateKey}`,
          `VITE_EXPLORER_URL=${env.VITE_EXPLORER_URL ?? ""}`,
          "PORT=3000",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await rename(temporary, environmentPath);
    } finally {
      await rm(temporary, { force: true });
    }
    await saveJson(join(directory, "public.json"), {
      rpcUrl: rpcUrl.href,
      networkId,
      counterAddress: toHex0x(address),
      signerAddress: toHex0x(account.address),
      codeHash: toHex0x(codeHash),
      value: view.value.toString(),
      height: view.height.toString(),
      transactions: Object.fromEntries(
        Object.entries(state.steps).map(([name, attempts]) => [
          name,
          attempts.at(-1)!.hash,
        ]),
      ),
    });
    console.log(
      `Verified counter value: ${view.value}\nRailway variables saved privately to: ${environmentPath}`,
    );
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setupDevnet().catch((error: unknown) => {
    console.error(
      error instanceof SeedError
        ? error.message
        : "Deployment stopped. Keep the deployment journal and signing key; inspect recorded transaction hashes before retrying.",
    );
    process.exitCode = 1;
  });
}
