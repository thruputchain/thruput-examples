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
import { gasAmount } from "@thruputchain/protocol";
import { parseConfig } from "../src/config";
import { Voting } from "../src/contracts/generated/voting";
import { setup } from "./index";
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
let directory: string;
let env: { VOTING_APP_ENV: string; VOTING_ARTIFACT: string };

async function readManifest(run: Pick<Run, "directory">) {
  return JSON.parse(
    await readFile(join(run.directory, "manifest.json"), "utf8"),
  );
}

async function readLatestRun() {
  const parent = join(directory, ".local", "voting-setup");
  const names = (await readdir(parent)).sort();
  const runDirectory = join(parent, names.at(-1)!);
  return {
    directory: runDirectory,
    manifest: await readManifest({ directory: runDirectory }),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "voting-setup-"));
  env = {
    VOTING_APP_ENV: join(directory, ".env.local"),
    VOTING_ARTIFACT: join(directory, "voting.rv32a"),
  };
  await writeFile(env.VOTING_ARTIFACT, "voting artifact");
  mocks.requestAirdrop.mockResolvedValue({
    transactionHash: new Uint8Array(32).fill(1),
    blockHeight: 4n,
  });
  mocks.deployContractAndWait.mockResolvedValue({
    transactionHash: receipt.transactionHash,
    receipt,
  });
  vi.spyOn(Voting.v0_1.count, "view").mockResolvedValue({ value: 0n } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  "http://192.168.1.5:9545",
  "https://rpc.example.test/?key=test",
  "https://rpc.example.test/#fragment",
  "https://user:password@rpc.example.test/",
])("rejects incompatible RPC URL %s before connecting", async (rpcUrl) => {
  await writeFile(env.VOTING_APP_ENV, "previous environment");
  await expect(setup({ ...env, THRUPUT_RPC_URL: rpcUrl })).rejects.toThrow(
    "Use HTTPS",
  );
  expect(createThruputClient).not.toHaveBeenCalled();
  expect(await readFile(env.VOTING_APP_ENV, "utf8")).toBe(
    "previous environment",
  );
});

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

it("deploys and funds atomically, then verifies empty state before publishing public configuration", async () => {
  await setup(env);
  const first = await readLatestRun();
  await setup(env);
  const latest = await readLatestRun();
  const environment = await readFile(env.VOTING_APP_ENV, "utf8");
  const config = parseConfig(parseEnv(environment));
  expect(latest.manifest.votingAddress).not.toBe(first.manifest.votingAddress);
  expect(latest.manifest.persona.address).not.toBe(
    first.manifest.persona.address,
  );
  expect(toBase58(config.address)).toBe(latest.manifest.votingAddress);
  expect(config.networkId).toBe(toBase58(new Uint8Array(32).fill(3)));
  expect(latest.manifest.status).toBe("complete");
  expect(latest.manifest.persona.name).toBe("Voting Deployer");
  expect(
    latest.manifest.transactions.map((tx: { status: string }) => tx.status),
  ).toEqual(["confirmed", "confirmed"]);
  const [deployment, options] = mocks.deployContractAndWait.mock.calls[1]!;
  expect(toBase58(deployment.address)).toBe(latest.manifest.votingAddress);
  expect(toBase58(deployment.deployer)).toBe(latest.manifest.persona.address);
  expect(options).toEqual({
    gasLimit: gasAmount(10_000_000n),
    amount: 10_000_000n,
  });
  expect(Voting.v0_1.count.view).toHaveBeenLastCalledWith(
    expect.objectContaining({ minStateBlockHeight: 7n }),
  );
  const keyPath = join(latest.directory, "key.json");
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  expect(key.address).toBe(latest.manifest.persona.address);
  expect(JSON.stringify(latest.manifest)).not.toContain(key.seed);
  expect(environment).not.toContain(key.seed);
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  expect((await stat(env.VOTING_APP_ENV)).mode & 0o777).toBe(0o600);
});

it.each(["funding", "deployment", "verification"])(
  "preserves the previous environment when %s fails",
  async (phase) => {
    await writeFile(env.VOTING_APP_ENV, "previous environment");
    if (phase === "funding")
      mocks.requestAirdrop.mockRejectedValueOnce(new Error("Funding stopped"));
    if (phase === "deployment")
      mocks.deployContractAndWait.mockRejectedValueOnce(
        new Error("Connection lost"),
      );
    if (phase === "verification")
      vi.mocked(Voting.v0_1.count.view).mockResolvedValue({
        value: 1n,
      } as never);
    await expect(setup(env)).rejects.toThrow();
    expect(await readFile(env.VOTING_APP_ENV, "utf8")).toBe(
      "previous environment",
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".env.local",
      ".local",
      "voting.rv32a",
    ]);
    const { manifest } = await readLatestRun();
    expect(manifest.status).toBe("failed");
    expect(manifest.votingAddress).toBeTruthy();
    if (phase !== "verification")
      expect(manifest.transactions.at(-1).status).toBe("unknown");
  },
);

it.each([
  ["local", "http://127.0.0.1:9545"],
  ["devnet", "https://rpc.thruput.network"],
] as const)(
  "uses %s defaults with network discovery and accepts an RPC override",
  async (network, rpcUrl) => {
    await setup(env, network);
    expect(createThruputClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({
          name: network,
          rpcUrl: new URL(rpcUrl).href,
        }),
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

it("retains an optional network pin and rejects conflicting manifest inputs", async () => {
  const path = join(directory, "manifest.json");
  const networkHash = new Uint8Array(32).fill(1);
  await writeFile(path, JSON.stringify({ networkHash: toBase58(networkHash) }));
  await setup({ ...env, THRUPUT_RUNTIME_MANIFEST: path });
  expect(createThruputClient).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cluster: expect.objectContaining({ networkHash }),
    }),
  );
  vi.clearAllMocks();
  await expect(
    setup({
      ...env,
      THRUPUT_RUNTIME_MANIFEST: path,
      THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
    }),
  ).rejects.toThrow("disagree");
  expect(createThruputClient).not.toHaveBeenCalled();
});

it("persists intent before submission and records committed failure", async () => {
  const run = await createRun(directory, toBase58(evidence.networkHash));
  const aborted: TransactionReceipt = {
    ...receipt,
    execution: { result: "abort", abortData: new Uint8Array([1]) },
  };
  await expect(
    record(run, "Deploy Voting", async () => {
      expect((await readManifest(run)).transactions).toEqual([
        { label: "Deploy Voting", status: "unknown" },
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
    await expect(record(run, "Deploy Voting", submit)).rejects.toBeInstanceOf(
      TransactionObservationError,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await readManifest(run)).transactions[0]).toMatchObject({
      status: phase === "beforeSubmission" ? "failed" : "unknown",
      hash: toBase58(evidence.transactionHash),
    });
  },
);

it("retains an uncertain faucet hash", async () => {
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
    record(run, "Fund Voting Deployer", submit),
  ).rejects.toBeInstanceOf(FundingObservationError);
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await readManifest(run)).transactions[0]).toMatchObject({
    status: "unknown",
    hash: toBase58(evidence.transactionHash),
  });
});
