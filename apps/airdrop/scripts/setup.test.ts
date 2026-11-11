// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createThruputClient,
  createWalletClient,
  toBase58,
  TransactionExecutionError,
  TransactionObservationError,
  type SubmissionEvidence,
  type TransactionReceipt,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
import { Airdrop } from "../src/contracts/generated/airdrop";
import { setup, storageFunding } from "./index";
import { createRun, record } from "./run";

const mocks = vi.hoisted(() => ({
  getBlockByHeight: vi.fn(),
  getNetworkInfo: vi.fn(),
  getChainConfig: vi.fn(),
  getBalance: vi.fn(),
  requestAirdrop: vi.fn(),
  executeAndWait: vi.fn(),
  deployContractAndWait: vi.fn(),
  link: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: mocks.link,
}));
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async () => ({
    network: { networkHash: new Uint8Array(32).fill(7) },
    ...mocks,
  })),
  createWalletClient: vi.fn(() => mocks),
}));

let directory: string;
let env: Record<string, string>;
let deployedAddress: Uint8Array | undefined;
let initializer: Airdrop.v0_1.InitializeArgs;
const network = toBase58(new Uint8Array(32).fill(7));
const anchor = toBase58(new Uint8Array(32).fill(8));
const token = {
  address: toBase58(new Uint8Array(32).fill(4)),
  symbol: "TEST",
  name: "Test Token",
  decimals: 6,
  claimAmount: "1000000",
};
const evidence: SubmissionEvidence = {
  networkHash: new Uint8Array(32).fill(7),
  transactionHash: new Uint8Array(32).fill(9),
  signedTransaction: new Uint8Array([1, 2, 3]),
};
const receipt: TransactionReceipt = {
  transactionHash: evidence.transactionHash,
  blockHeight: 5n,
  events: [],
  gasUsed: 1n,
  execution: { result: "return", returnData: new Uint8Array() },
};

async function signedResult() {
  const options = vi.mocked(createWalletClient).mock.calls.at(-1)![0];
  await options.onSigned!(evidence);
  return { transactionHash: evidence.transactionHash, receipt };
}
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "airdrop-setup-test-"));
  env = {
    AIRDROP_ENV_PATH: join(directory, "app.env"),
    AIRDROP_ARTIFACT: join(directory, "airdrop.rv32a"),
    AIRDROP_SETUP_DIR: join(directory, "runs"),
    AIRDROP_TOKENS_FILE: join(directory, "tokens.json"),
    AIRDROP_DEPLOYER_PRIVATE_KEY: `0x${"01".repeat(32)}`,
    AIRDROP_PACKS: "2",
  };
  await writeFile(env.AIRDROP_ARTIFACT!, "airdrop-code");
  await writeFile(env.AIRDROP_TOKENS_FILE!, JSON.stringify([token]));
  deployedAddress = undefined;
  initializer = {
    rewards: [{ token: new Uint8Array(32).fill(4) as never, amount: 1000000n }],
    addresses: [],
  };
  mocks.getBlockByHeight.mockResolvedValue({
    blockHash: new Uint8Array(32).fill(8),
  });
  mocks.getNetworkInfo.mockResolvedValue({
    networkHash: new Uint8Array(32).fill(7),
  });
  mocks.getChainConfig.mockResolvedValue({
    execution: { storageCosts: costs },
  });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  mocks.requestAirdrop.mockResolvedValue({
    transactionHash: evidence.transactionHash,
    blockHeight: 2n,
  });
  mocks.executeAndWait.mockImplementation(signedResult);
  mocks.deployContractAndWait.mockImplementation(async (deployment) => {
    deployedAddress = deployment.address;
    return { ...(await signedResult()), address: deployment.address };
  });
  mocks.link.mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).link,
  );
  vi.spyOn(ERC20Metadata.v0_1.symbol, "view").mockResolvedValue({
    value: "TEST",
  } as never);
  vi.spyOn(ERC20Metadata.v0_1.decimals, "view").mockResolvedValue({
    value: 6n,
  } as never);
  vi.spyOn(ERC20.v0_1.getBalanceOf, "view").mockImplementation(
    async (options) =>
      ({
        value:
          deployedAddress &&
          toBase58(options.args.addr) === toBase58(deployedAddress)
            ? 2_000_000n
            : 10_000_000n,
      }) as never,
  );
  vi.spyOn(Airdrop.v0_1.config, "view").mockImplementation(
    async () =>
      ({ value: { restricted: false, rewards: initializer.rewards } }) as never,
  );
  vi.spyOn(Airdrop.v0_1.eligible, "view").mockResolvedValue({
    value: true,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function latestRun() {
  const [name] = await readdir(env.AIRDROP_SETUP_DIR!);
  const path = join(env.AIRDROP_SETUP_DIR!, name!);
  return {
    path,
    manifest: JSON.parse(await readFile(join(path, "manifest.json"), "utf8")),
  };
}

const costs = {
  baseContractDeploymentCost: 12000n,
  contractDeploymentCostPerByte: 1n,
  baseDataItemCost: 12000n,
  bytestringCostPerByte: 10n,
  balanceCost: 1234n,
  authPerKeyCost: 0n,
  rcqCostPerEntry: 0n,
  replayCacheCostPerEntry: 0n,
};
it("covers the maximum claim budget, allowlist, code, and new token balance rows", () => {
  for (const packs of [1000n, 10000n]) {
    const budget = storageFunding(costs, packs, 256, 50000);
    expect(budget.airdrop).toBeGreaterThan(
      (packs + 256n) * 12000n + 50000n + 12000n,
    );
    expect(budget.token).toBeGreaterThan((packs + 1n) * 12000n);
  }
});
it("uses the network's byte and base costs", () => {
  const budget = storageFunding(costs, 1000n, 0, 50000);
  const doubled = Object.fromEntries(
    Object.entries(costs).map(([key, value]) => [key, value * 2n]),
  ) as typeof costs;
  expect(storageFunding(doubled, 1000n, 0, 50000).airdrop).toBe(
    budget.airdrop * 2n,
  );
});

it.each(["local", "devnet"] as const)(
  "uses the same atomic deployment and evidence flow for %s",
  async (mode) => {
    await setup(env, mode);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
    expect(mocks.deployContractAndWait).toHaveBeenCalledOnce();
    const [deployment, options] = mocks.deployContractAndWait.mock.calls[0]!;
    expect(options.amount).toBe(storageFunding(costs, 2n, 0, 12).airdrop);
    expect(options.initializer).toEqual(
      Airdrop.v0_1.initialize.invocation(
        deployment.address,
        options.gasLimit,
        initializer,
      ),
    );
    expect(mocks.executeAndWait).toHaveBeenCalledTimes(2);
    expect(Airdrop.v0_1.config.view).toHaveBeenCalledWith(
      expect.objectContaining({ minStateBlockHeight: 5n }),
    );
    const { path, manifest } = await latestRun();
    expect(manifest.status).toBe("complete");
    expect(
      manifest.transactions.map((item: { status: string }) => item.status),
    ).toEqual(["confirmed", "confirmed", "confirmed"]);
    const files = await readdir(path);
    expect(files.filter((name) => name.endsWith(".signed.json"))).toHaveLength(
      3,
    );
    expect(files.filter((name) => name.endsWith(".receipt.json"))).toHaveLength(
      3,
    );
    expect((await stat(join(path, "key.json"))).mode & 0o777).toBe(0o600);
    const output = await readFile(env.AIRDROP_ENV_PATH!, "utf8");
    expect(output).toContain(`AIRDROP_ANCHOR_HASH='${anchor}'`);
    expect(output).toContain(`THRUPUT_NETWORK_ID='${network}'`);
    expect(output).not.toContain(env.AIRDROP_DEPLOYER_PRIVATE_KEY);
    expect(
      vi.mocked(createThruputClient).mock.calls[0]![0]!.cluster,
    ).not.toHaveProperty("networkHash");
  },
);

it("saves signed evidence and intent before the SDK submission completes", async () => {
  mocks.deployContractAndWait.mockImplementation(async (deployment) => {
    deployedAddress = deployment.address;
    await signedResult();
    const { path, manifest } = await latestRun();
    expect(manifest.transactions[0]).toMatchObject({
      status: "unknown",
      hash: toBase58(evidence.transactionHash),
    });
    expect(
      JSON.parse(await readFile(join(path, "001.signed.json"), "utf8")),
    ).toMatchObject({
      hash: toBase58(evidence.transactionHash),
      signed: "0x010203",
    });
    throw new TransactionObservationError(
      evidence,
      new Error("Submission disconnected"),
    );
  });
  await expect(setup(env)).rejects.toBeInstanceOf(TransactionObservationError);
  expect(mocks.deployContractAndWait).toHaveBeenCalledOnce();
  expect(mocks.executeAndWait).not.toHaveBeenCalled();
  expect((await latestRun()).manifest.transactions[0].status).toBe("unknown");
  await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("fails the signing hook if the evidence cannot be saved", async () => {
  mocks.deployContractAndWait.mockImplementation(async () => {
    const { path } = await latestRun();
    await mkdir(join(path, "001.signed.json"));
    return signedResult();
  });
  await expect(setup(env)).rejects.toThrow();
  expect(mocks.executeAndWait).not.toHaveBeenCalled();
  await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["network", "checkpoint"])(
  "rejects a changed %s in the signing hook",
  async (field) => {
    if (field === "network")
      mocks.getNetworkInfo.mockResolvedValue({
        networkHash: new Uint8Array(32),
      });
    else
      mocks.getBlockByHeight
        .mockResolvedValueOnce({ blockHash: new Uint8Array(32).fill(8) })
        .mockResolvedValue({ blockHash: new Uint8Array(32) });
    await expect(setup(env)).rejects.toThrow(/Network changed/);
    expect(mocks.executeAndWait).not.toHaveBeenCalled();
    const { path } = await latestRun();
    expect(
      (await readdir(path)).some((name) => name.endsWith(".signed.json")),
    ).toBe(false);
  },
);

it.each(["symbol", "decimals", "balance"])(
  "rejects an existing token %s mismatch before funding",
  async (field) => {
    if (field === "symbol")
      vi.mocked(ERC20Metadata.v0_1.symbol.view).mockResolvedValueOnce({
        value: "OTHER",
      } as never);
    if (field === "decimals")
      vi.mocked(ERC20Metadata.v0_1.decimals.view).mockResolvedValueOnce({
        value: 7n,
      } as never);
    if (field === "balance")
      vi.mocked(ERC20.v0_1.getBalanceOf.view).mockResolvedValueOnce({
        value: 1n,
      } as never);
    await expect(setup(env)).rejects.toThrow(/metadata or deployer balance/);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
    expect(mocks.deployContractAndWait).not.toHaveBeenCalled();
  },
);

it.each(["reward", "amount", "balance", "restricted"])(
  "rejects incorrect final %s before publishing",
  async (field) => {
    if (field === "reward")
      initializer.rewards[0]!.token = new Uint8Array(32).fill(5) as never;
    if (field === "amount") initializer.rewards[0]!.amount = 1n;
    if (field === "balance")
      vi.mocked(ERC20.v0_1.getBalanceOf.view)
        .mockResolvedValueOnce({ value: 10_000_000n } as never)
        .mockResolvedValue({ value: 1n } as never);
    if (field === "restricted")
      vi.mocked(Airdrop.v0_1.config.view).mockResolvedValue({
        value: { restricted: true, rewards: initializer.rewards },
      } as never);
    await expect(setup(env)).rejects.toThrow(/mismatch/);
    await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("checks each allowlisted address after initialization", async () => {
  const path = join(directory, "addresses.json");
  await writeFile(path, JSON.stringify([toBase58(new Uint8Array(32).fill(3))]));
  vi.mocked(Airdrop.v0_1.config.view).mockResolvedValue({
    value: { restricted: true, rewards: initializer.rewards },
  } as never);
  vi.mocked(Airdrop.v0_1.eligible.view).mockResolvedValue({
    value: false,
  } as never);
  await expect(setup({ ...env, AIRDROP_ADDRESSES_FILE: path })).rejects.toThrow(
    /eligibility/,
  );
  expect(Airdrop.v0_1.eligible.view).toHaveBeenCalledWith(
    expect.objectContaining({ minStateBlockHeight: 5n }),
  );
});

it("stops when a confirmed faucet response does not increase the observed balance", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  await expect(setup(env)).rejects.toThrow(/funding is not visible/);
  expect(mocks.requestAirdrop).toHaveBeenCalledOnce();
  expect(mocks.deployContractAndWait).not.toHaveBeenCalled();
});

it("keeps an existing environment without contacting a node", async () => {
  await writeFile(env.AIRDROP_ENV_PATH!, "previous configuration");
  await expect(setup(env)).rejects.toThrow(/already exists/);
  expect(createThruputClient).not.toHaveBeenCalled();
  expect(await readFile(env.AIRDROP_ENV_PATH!, "utf8")).toBe(
    "previous configuration",
  );
});

it("does not replace an output created during setup", async () => {
  const link = (
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  ).link;
  mocks.link.mockImplementation(async (source, destination) => {
    await writeFile(destination, "other distribution");
    return link(source, destination);
  });
  await expect(setup(env)).rejects.toThrow();
  expect(await readFile(env.AIRDROP_ENV_PATH!, "utf8")).toBe(
    "other distribution",
  );
  expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
});

it("requires an existing-token owner and validates optional network pins before RPC", async () => {
  await expect(
    setup({ ...env, AIRDROP_DEPLOYER_PRIVATE_KEY: undefined }),
  ).rejects.toThrow(/signer that owns/);
  const manifest = join(directory, "runtime.json");
  await writeFile(manifest, JSON.stringify({ networkHash: network }));
  await expect(
    setup({
      ...env,
      THRUPUT_RUNTIME_MANIFEST: manifest,
      THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
    }),
  ).rejects.toThrow(/disagree/);
  expect(createThruputClient).not.toHaveBeenCalled();
  await setup({ ...env, THRUPUT_RUNTIME_MANIFEST: manifest });
  expect(
    vi.mocked(createThruputClient).mock.calls[0]![0]!.cluster,
  ).toMatchObject({ networkHash: new Uint8Array(32).fill(7) });
});

it("rejects RPC URLs the claim server cannot use before contacting the node", async () => {
  await expect(
    setup({ ...env, THRUPUT_RPC_URL: "http://remote.example" }),
  ).rejects.toThrow(/HTTPS RPC or loopback HTTP/);
  expect(createThruputClient).not.toHaveBeenCalled();
});

it("records a failed execution and its receipt", async () => {
  const run = await createRun(directory, network, anchor);
  const failed: TransactionReceipt = {
    ...receipt,
    execution: { result: "abort", abortData: new Uint8Array([1]) },
  };
  await expect(
    record(run, "Deploy", async () => {
      throw new TransactionExecutionError(failed, evidence);
    }),
  ).rejects.toBeInstanceOf(TransactionExecutionError);
  expect(run.manifest.transactions[0]).toMatchObject({
    status: "failed",
    hash: toBase58(evidence.transactionHash),
  });
  expect(
    JSON.parse(await readFile(join(run.directory, "001.receipt.json"), "utf8"))
      .execution.result,
  ).toBe("abort");
});
