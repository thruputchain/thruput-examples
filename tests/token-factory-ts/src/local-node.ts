import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import {
  HttpTransport,
  createSourceAddressAccount,
  createGroundhogClient,
  createWalletClient,
  devWalletAdapter,
  localnet,
  type ConnectedGroundhogClient,
  type ExecutableWalletClient,
  type SourceAddressAccount,
} from "@groundhogchain/client";
import { bitMap, weight, type ContractAddress } from "@groundhogchain/protocol";
import { loadLocalDevAccount } from "@groundhogchain/client/local-dev";

const expectedProducer = {
  binary: "hog-devnode",
  version: "0.1.25-rc.1",
} as const;

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
  producer: typeof expectedProducer & { commitHash: string };
  bootstrapAccountDerivation: { scheme: string; seed: string };
  bootstrap: {
    devWallet: {
      deployEntrypoint: string;
      doActionEntrypoint: string;
    };
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

export interface LocalAccount {
  address: ContractAddress;
  wallet: ExecutableWalletClient<ConnectedGroundhogClient, SourceAddressAccount>;
}

export interface LocalNode {
  client: ConnectedGroundhogClient;
  accounts: LocalAccount[];
  manifest: RuntimeManifestJson;
  stop(): Promise<void>;
}

export async function startLocalNode(): Promise<LocalNode> {
  const groundhog =
    process.env["GROUNDHOG_NODE"] ?? process.env["GROUNDHOG"] ?? "groundhog";
  const version = execFileSync(groundhog, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== "groundhog 0.10.4") {
    throw new Error(`Expected groundhog node supervisor 0.10.4, received ${version}`);
  }
  const devnode =
    process.env["GROUNDHOG_DEVNODE_BINARY"] ??
    join(homedir(), ".local/share/groundhog/hog-devnode/hog-devnode");
  const stateRoot = resolve(
    tmpdir(),
    `groundhog-token-factory-ts-${process.pid}-${Date.now()}`,
  );
  const configHome = join(stateRoot, "config");
  const cacheHome = join(stateRoot, "cache");
  const child = spawn(
    groundhog,
    [
      "node",
      "--json",
      "--verbose",
      "--port",
      "0",
      "--dev-account-count",
      "2",
      "--hog-devnode-binary",
      devnode,
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
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
    const client = await connect(startup.data.rpc_url);
    const accountEnv = {
      ...process.env,
      GROUNDHOG_RUNTIME_MANIFEST: startup.data.runtime_manifest.path,
    };
    const accounts = await Promise.all([
      loadAccount(startup.data.rpc_url, accountEnv, 0),
      loadAccount(startup.data.rpc_url, accountEnv, 1),
    ]);

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

function assertManifest(manifest: RuntimeManifestJson): void {
  const costs = manifest.bootstrap.storageCostModel;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.kind !== "hogd-dev-runtime" ||
    manifest.chainState !== "fresh" ||
    manifest.producer.binary !== expectedProducer.binary ||
    manifest.producer.version !== expectedProducer.version ||
    manifest.producer.commitHash.length === 0 ||
    manifest.bootstrapAccountDerivation.scheme !==
      "groundhog-bootstrap-account-v1" ||
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

async function connect(rpcUrl: string): Promise<ConnectedGroundhogClient> {
  return createGroundhogClient({
    cluster: localnet({ rpcUrl }),
    transport: new HttpTransport(rpcUrl, { timeoutMs: 10_000 }),
  });
}

async function loadAccount(
  rpcUrl: string,
  env: Readonly<Record<string, string | undefined>>,
  roleOffset: number,
): Promise<LocalAccount> {
  const local = await loadLocalDevAccount({ roleOffset, env });
  const account = createSourceAddressAccount({
    address: local.address,
    signers: [{ signer: local.signer, publicKeyId: 0n }],
    allowedKeys: bitMap(1n),
    requiredWeight: weight(1n),
  });
  return {
    address: account.address,
    wallet: createWalletClient({
      client: await connect(rpcUrl),
      account,
      invocationAdapter: devWalletAdapter,
    }),
  };
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
