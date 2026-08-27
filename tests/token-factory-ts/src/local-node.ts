import { createHash } from "node:crypto";
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
  PrivateKeySigner,
  addressFromHex,
  createGroundhogClient,
  fromHex0x,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { type ContractAddress } from "@groundhogchain/protocol";

const expectedProtocol = "hogp/0cd3c454cdeb";
const expectedProducer = {
  binary: "hog-devnode",
  version: "0.1.19",
  commitHash: "046159036753c9c92ed0b13d66c6ad1e6ea6ccf7",
} as const;

interface StartupData {
  rpc_url: string;
  runtime_manifest: { path: string };
}

interface StartupEnvelope {
  ok: boolean;
  data: StartupData;
}

interface BootstrapAccountJson {
  index: number;
  role: string;
  publicKey: string;
  walletAddress: string;
}

interface RuntimeManifestJson {
  schemaVersion: number;
  kind: string;
  chainState: string;
  protocol: string;
  producer: typeof expectedProducer;
  bootstrapAccountDerivation: { scheme: string; seed: string };
  bootstrapAccounts: BootstrapAccountJson[];
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
  signer: PrivateKeySigner;
}

export interface LocalNode {
  client: GroundhogClient;
  accounts: LocalAccount[];
  manifest: RuntimeManifestJson;
  stop(): Promise<void>;
}

export async function startLocalNode(): Promise<LocalNode> {
  const groundhog = process.env["GROUNDHOG_NODE"] ?? "groundhog";
  const version = execFileSync(groundhog, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== "groundhog 0.9.1") {
    throw new Error(`Expected groundhog node supervisor 0.9.1, received ${version}`);
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
      "--hogd-protocol",
      expectedProtocol,
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
    const accounts = manifest.bootstrapAccounts
      .filter((account) => account.role === "local_user")
      .sort((left, right) => left.index - right.index)
      .map((account) => deriveAccount(manifest, account));
    if (accounts.length !== 2) {
      throw new Error(`Expected two local users, received ${accounts.length}`);
    }

    return {
      client: createGroundhogClient(
        new HttpTransport(startup.data.rpc_url, { timeoutMs: 10_000 }),
      ),
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
    manifest.protocol !== expectedProtocol ||
    manifest.producer.binary !== expectedProducer.binary ||
    manifest.producer.version !== expectedProducer.version ||
    manifest.producer.commitHash !== expectedProducer.commitHash ||
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

function deriveAccount(
  manifest: RuntimeManifestJson,
  account: BootstrapAccountJson,
): LocalAccount {
  const secret = createHash("sha256")
    .update(`${manifest.bootstrapAccountDerivation.seed}:account-${account.index}`)
    .digest();
  const signer = new PrivateKeySigner(secret);
  if (toHex0x(signer.publicKey.ed25519) !== toHex0x(fromHex0x(account.publicKey))) {
    throw new Error(`Derived key does not match bootstrap account ${account.index}`);
  }
  return {
    address: addressFromHex(account.walletAddress),
    signer,
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
