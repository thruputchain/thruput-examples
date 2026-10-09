import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import {
  HttpTransport,
  PrivateKeySigner,
  createGroundhogClient,
  createPubkeyAccount,
  createWalletClient,
  localnet,
  toHex0x,
  type ConnectedGroundhogClient,
  type ExecutableWalletClient,
  type PubkeyAccount,
} from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

/** Raw HOG each harness account starts with (100 HOG). */
const initialAccountTokens = 1_000_000_000n;
const accountCount = 2;

interface StartupData {
  rpc_url: string;
  runtime_manifest: { path: string };
}

interface StartupEnvelope {
  ok: boolean;
  data: StartupData;
}

interface RuntimeManifestJson {
  schemaVersion: number;
  kind: string;
  chainState: string;
  protocol: string;
  producer: { binary: string; version: string; commitHash: string };
  bootstrapAccounts: {
    role: string;
    publicKey: string;
    walletAddress: string;
    initialStorageTokens: string;
  }[];
  bootstrap: {
    storageCostModel: {
      hash: string;
      baseDataItemCost: string;
      bytestringCostPerByte: string;
      baseContractDeploymentCost: string;
      contractDeploymentCostPerByte: string;
      authPerKeyCost: string;
      rcqCostPerEntry: string;
      replayCacheCostPerEntry: string;
      balanceCost: string;
    };
  };
}

/** A key the harness owns and the native account (its default wallet) it controls. */
export interface LocalAccount {
  address: ContractAddress;
  wallet: ExecutableWalletClient<ConnectedGroundhogClient, PubkeyAccount>;
}

export interface LocalNode {
  client: ConnectedGroundhogClient<ReturnType<typeof localnet>>;
  accounts: LocalAccount[];
  manifest: RuntimeManifestJson;
  stop(): Promise<void>;
}

export async function startLocalNode(): Promise<LocalNode> {
  const groundhog =
    process.env["GROUNDHOG_NODE"] ?? process.env["GROUNDHOG"] ?? "groundhog";
  const repository = resolve(import.meta.dirname, "../../..");
  const version = execFileSync(groundhog, ["--version"], {
    encoding: "utf8",
  }).trim();
  execFileSync(
    "bash",
    [join(repository, "scripts/check-groundhog-version.sh"), version],
    { stdio: "inherit" },
  );
  const devnode =
    process.env["GROUNDHOG_DEVNODE_BINARY"] ??
    execFileSync(groundhog, ["toolchain", "which"], { encoding: "utf8" }).trim();
  const stateRoot = resolve(
    tmpdir(),
    `groundhog-token-factory-ts-${process.pid}-${Date.now()}`,
  );
  await mkdir(stateRoot, { recursive: true });

  // The node funds exactly these keys' native accounts at genesis, and no
  // others; the harness holds the only copies of the private keys.
  const signers = Array.from(
    { length: accountCount },
    () => new PrivateKeySigner(randomBytes(32)),
  );
  const allocations = join(stateRoot, "bootstrap-accounts.json");
  await writeFile(
    allocations,
    JSON.stringify(
      signers.map((signer) => ({
        publicKey: toHex0x(signer.publicKey.ed25519),
        initialStorageTokens: initialAccountTokens.toString(),
      })),
    ),
  );

  const child = spawn(
    groundhog,
    [
      "node",
      "--json",
      "--verbose",
      "--port",
      "0",
      "--bootstrap-accounts",
      allocations,
      "--hog-devnode-binary",
      devnode,
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(stateRoot, "config"),
        XDG_DATA_HOME: join(stateRoot, "data"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const startup = await readStartup(child, () => stderr);
    const manifest = JSON.parse(
      await readFile(startup.data.runtime_manifest.path, "utf8"),
    ) as RuntimeManifestJson;
    assertManifest(manifest);
    const rpcUrl = startup.data.rpc_url;
    const client = await connect(rpcUrl);
    const accounts = await Promise.all(
      signers.map(async (signer) => {
        const account = createPubkeyAccount({ signer });
        assertFunded(manifest, toHex0x(signer.publicKey.ed25519), toHex0x(account.address));
        return {
          address: account.address,
          wallet: createWalletClient({ client: await connect(rpcUrl), account }),
        };
      }),
    );

    return {
      client,
      accounts,
      manifest,
      async stop() {
        await stopChild(child);
        await rm(stateRoot, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await stopChild(child);
    await rm(stateRoot, { recursive: true, force: true });
    throw cause;
  }
}

async function readStartup(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<StartupEnvelope> {
  const lines = createInterface({ input: child.stdout });
  let timeout: NodeJS.Timeout | undefined;
  const startup = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(String(line)) as StartupEnvelope),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `groundhog node exited before readiness (${String(code ?? signal)}): ${stderr()}`,
      );
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("groundhog node readiness timed out")),
        60_000,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    lines.close();
  });
  if (!startup.ok) {
    throw new Error(
      `groundhog node reported startup failure: ${JSON.stringify(startup)}\n${stderr()}`,
    );
  }
  return startup;
}

// The test's exact funding figures assume this storage cost model.
function assertManifest(manifest: RuntimeManifestJson): void {
  const costs = manifest.bootstrap.storageCostModel;
  if (
    manifest.schemaVersion !== 4 ||
    manifest.kind !== "hogd-dev-runtime" ||
    manifest.chainState !== "fresh" ||
    manifest.producer.binary !== "hog-devnode" ||
    manifest.producer.commitHash.length === 0 ||
    costs.hash !==
      "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce" ||
    costs.baseDataItemCost !== "12000" ||
    costs.bytestringCostPerByte !== "10" ||
    costs.baseContractDeploymentCost !== "12000" ||
    costs.contractDeploymentCostPerByte !== "10" ||
    costs.authPerKeyCost !== "1111" ||
    costs.rcqCostPerEntry !== "8" ||
    costs.replayCacheCostPerEntry !== "7" ||
    costs.balanceCost !== "1234"
  ) {
    throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
  }
}

function assertFunded(
  manifest: RuntimeManifestJson,
  publicKey: string,
  walletAddress: string,
): void {
  const funded = manifest.bootstrapAccounts.some(
    (account) =>
      account.role === "local_user" &&
      account.publicKey.toLowerCase() === publicKey &&
      account.walletAddress.toLowerCase() === walletAddress &&
      account.initialStorageTokens === initialAccountTokens.toString(),
  );
  if (!funded) {
    throw new Error(
      `Runtime manifest funds no native account ${walletAddress} for key ${publicKey}`,
    );
  }
}

async function connect(
  rpcUrl: string,
): Promise<ConnectedGroundhogClient<ReturnType<typeof localnet>>> {
  return createGroundhogClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGINT");
  let timeout: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 10_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}
