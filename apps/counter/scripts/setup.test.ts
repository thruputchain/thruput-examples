import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createThruputClient,
  createWalletClient,
  FundingObservationError,
  TransactionExecutionError,
  TransactionObservationError,
  toBase58,
  type TransactionReceipt,
} from "@thruputchain/client";
import type { ContractDeployment } from "@thruputchain/client/wallet";
import { gasAmount } from "@thruputchain/protocol";
import { loadServerConfig } from "../server/config";
import { Counter } from "../src/contracts/generated/counter";
import { provisionCounter, setup } from "./index";
import { createPersona, createRun, record, type Client, type Run } from "./run";

const mocks = vi.hoisted(() => ({
  requestAirdrop: vi.fn(),
  deployContractAndWait: vi.fn(),
}));
vi.mock("@thruputchain/client", async (original) => {
  const sdk = await original<typeof import("@thruputchain/client")>();
  return {
    ...sdk,
    createThruputClient: vi.fn(async () => ({
      network: { networkHash: new Uint8Array(32).fill(3) },
    })),
    createWalletClient: vi.fn(() => mocks),
  };
});

let directory: string;
let options: Parameters<typeof provisionCounter>[0];
const receipt: TransactionReceipt = {
  transactionHash: new Uint8Array(32).fill(2),
  blockHeight: 7n,
  execution: { result: "return", returnData: new Uint8Array() },
  events: [],
  gasUsed: 100n,
};

const evidence = {
  transactionHash: receipt.transactionHash,
  networkHash: new Uint8Array(32),
  signedTransaction: new Uint8Array([1, 2, 3]),
};

async function readManifest(run: Run) {
  return JSON.parse(
    await readFile(join(run.directory, "manifest.json"), "utf8"),
  );
}

async function readRun() {
  const parent = join(directory, ".local", "counter-setup");
  const names = (await readdir(parent)).sort();
  const runDirectory = join(parent, names.at(-1)!);
  const manifest = JSON.parse(
    await readFile(join(runDirectory, "manifest.json"), "utf8"),
  );
  return { runDirectory, manifest };
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "counter-setup-"));
  options = {
    network: "local",
    rpcUrl: "http://127.0.0.1:9545",
    output: join(directory, ".env.local"),
    artifact: join(directory, "counter.rv32a"),
  };
  await writeFile(options.artifact!, "counter artifact");
  mocks.requestAirdrop.mockResolvedValue({
    transactionHash: new Uint8Array(32).fill(1),
    blockHeight: 4n,
  });
  mocks.deployContractAndWait.mockImplementation(
    async (deployment: ContractDeployment) => ({
      transactionHash: receipt.transactionHash,
      receipt,
      address: deployment.address,
    }),
  );
  vi.spyOn(Counter.v0_1.get, "view").mockResolvedValue({
    value: 1_000_000n,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("publishes a fresh signer and atomic deployment, then verifies confirmed state", async () => {
  await provisionCounter(options);
  const first = loadServerConfig(
    parseEnv(await readFile(options.output, "utf8")),
  ).app;
  await provisionCounter(options);
  const environment = await readFile(options.output, "utf8");
  const second = loadServerConfig(parseEnv(environment)).app;
  expect(second.counterAddress).not.toBe(first.counterAddress);
  expect(second.signerAddress).not.toBe(first.signerAddress);
  expect(second.networkId).toBe(toBase58(new Uint8Array(32).fill(3)));
  expect((await stat(options.output)).mode & 0o777).toBe(0o600);
  const [deployment, deployOptions] =
    mocks.deployContractAndWait.mock.calls[1]!;
  expect(toBase58(deployment.address)).toBe(second.counterAddress);
  expect(toBase58(deployment.deployer)).toBe(second.signerAddress);
  expect(deployOptions).toEqual({
    gasLimit: gasAmount(10_000_000n),
    amount: 10_000_000n,
    initializer: Counter.v0_1.initialize.invocation(
      deployment.address,
      gasAmount(500_000n),
      {
        initialValue: 1_000_000n,
      },
    ),
  });
  expect(Counter.v0_1.get.view).toHaveBeenLastCalledWith(
    expect.objectContaining({ minStateBlockHeight: 7n }),
  );
  const { runDirectory, manifest } = await readRun();
  expect(manifest.status).toBe("complete");
  expect(
    manifest.transactions.map((tx: { status: string }) => tx.status),
  ).toEqual(["confirmed", "confirmed"]);
  const key = JSON.parse(
    await readFile(join(runDirectory, "key.json"), "utf8"),
  );
  expect(key.address).toBe(second.signerAddress);
  expect(parseEnv(environment).COUNTER_SIGNING_PRIVATE_KEY).toBe(key.seed);
  expect(JSON.stringify(manifest)).not.toContain(key.seed);
  expect((await stat(join(runDirectory, "key.json"))).mode & 0o777).toBe(0o600);
});

it.each(["funding", "deployment", "verification"])(
  "preserves the previous environment when %s fails",
  async (phase) => {
    await writeFile(options.output, "previous environment");
    if (phase === "funding")
      mocks.requestAirdrop.mockRejectedValueOnce(new Error("Funding stopped"));
    if (phase === "deployment")
      mocks.deployContractAndWait.mockRejectedValueOnce(
        new Error("Connection lost"),
      );
    if (phase === "verification")
      vi.mocked(Counter.v0_1.get.view).mockResolvedValue({
        value: 0n,
      } as never);
    await expect(provisionCounter(options)).rejects.toThrow();
    expect(await readFile(options.output, "utf8")).toBe("previous environment");
    expect((await readdir(directory)).sort()).toEqual([
      ".env.local",
      ".local",
      "counter.rv32a",
    ]);
    const { manifest } = await readRun();
    expect(manifest.status).toBe("failed");
    expect(manifest.counterAddress).toBeTruthy();
    if (phase !== "verification")
      expect(manifest.transactions.at(-1).status).toBe("unknown");
  },
);

it("saves signed evidence before observation and rejects evidence overwrite", async () => {
  const run = await createRun(directory, toBase58(evidence.networkHash));
  await createPersona({} as Client, run, "Operator");
  const onSigned = vi.mocked(createWalletClient).mock.calls.at(-1)![0]
    .onSigned!;
  await record(run, "Deploy", async () => {
    await onSigned(evidence);
    expect((await readManifest(run)).transactions[0]).toMatchObject({
      status: "unknown",
      hash: toBase58(evidence.transactionHash),
    });
    const path = join(run.directory, "001.signed.json");
    const saved = await readFile(path, "utf8");
    expect(JSON.parse(saved)).toEqual({
      network: toBase58(evidence.networkHash),
      hash: toBase58(evidence.transactionHash),
      signed: "0x010203",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(onSigned(evidence)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(saved);
    return { hash: evidence.transactionHash, blockHeight: 7n };
  });
});

it("persists intent before submission and marks a committed abort as failed", async () => {
  const run = await createRun(directory, toBase58(evidence.networkHash));
  const aborted: TransactionReceipt = {
    ...receipt,
    execution: { result: "abort", abortData: new Uint8Array([1]) },
  };
  await expect(
    record(run, "Deploy Counter", async () => {
      expect((await readManifest(run)).transactions).toEqual([
        { label: "Deploy Counter", status: "unknown" },
      ]);
      throw new TransactionExecutionError(aborted, evidence);
    }),
  ).rejects.toBeInstanceOf(TransactionExecutionError);
  expect((await readManifest(run)).transactions[0]).toMatchObject({
    status: "failed",
    hash: toBase58(evidence.transactionHash),
  });
});

it.each(["beforeSubmission", "submission", "observation"] as const)(
  "records %s without retrying",
  async (phase) => {
    const run = await createRun(directory, toBase58(evidence.networkHash));
    const submit = vi.fn(async () => {
      throw new TransactionObservationError(
        evidence,
        new Error("Stopped"),
        undefined,
        undefined,
        phase,
      );
    });
    await expect(record(run, "Deploy Counter", submit)).rejects.toBeInstanceOf(
      TransactionObservationError,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await readManifest(run)).transactions[0]).toMatchObject({
      status: phase === "beforeSubmission" ? "failed" : "unknown",
      hash: toBase58(evidence.transactionHash),
    });
  },
);

it("retains an uncertain faucet transaction hash", async () => {
  const run = await createRun(directory, toBase58(evidence.networkHash));
  const submit = vi.fn(async () => {
    throw new FundingObservationError(
      {
        recipient: new Uint8Array(32),
        clientNonce: new Uint8Array(16),
        networkHash: evidence.networkHash,
      },
      {
        attemptStatus: "pending",
        recipient: new Uint8Array(32),
        rawAmount: 100000000n,
        retryAfterSeconds: 1n,
        transactionHash: evidence.transactionHash,
      },
      new Error("Timeout"),
    );
  });
  await expect(
    record(run, "Fund Counter Operator", submit),
  ).rejects.toBeInstanceOf(FundingObservationError);
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await readManifest(run)).transactions[0]).toMatchObject({
    status: "unknown",
    hash: toBase58(evidence.transactionHash),
  });
});

it.each([
  ["local", "http://127.0.0.1:9545"],
  ["devnet", "https://rpc.thruput.network"],
] as const)(
  "uses %s defaults without a manifest and accepts an RPC override",
  async (network, rpcUrl) => {
    const env = {
      COUNTER_APP_ENV: options.output,
      COUNTER_ARTIFACT: options.artifact,
    };
    await setup(env, network);
    expect(createThruputClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({ name: network, rpcUrl }),
      }),
    );
    expect(
      vi.mocked(createThruputClient).mock.calls.at(-1)?.[0]?.cluster,
    ).not.toHaveProperty("networkHash");
    await setup(
      { ...env, THRUPUT_RPC_URL: "https://example.test/rpc" },
      network,
    );
    expect(createThruputClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({
          rpcUrl: "https://example.test/rpc",
        }),
      }),
    );
  },
);

it("retains optional manifest pins and rejects conflicting network inputs", async () => {
  const path = join(directory, "manifest.json");
  const networkHash = new Uint8Array(32).fill(1);
  await writeFile(path, JSON.stringify({ networkHash: toBase58(networkHash) }));
  const env = {
    COUNTER_APP_ENV: options.output,
    COUNTER_ARTIFACT: options.artifact,
    THRUPUT_RUNTIME_MANIFEST: path,
  };
  await setup(env);
  expect(createThruputClient).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cluster: expect.objectContaining({ networkHash }),
    }),
  );
  vi.clearAllMocks();
  await expect(
    setup({ ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)) }),
  ).rejects.toThrow("disagree");
  expect(createThruputClient).not.toHaveBeenCalled();
});
