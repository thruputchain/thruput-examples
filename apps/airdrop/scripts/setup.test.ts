// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createThruputClient,
  toBase58,
  ThruputError,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
import { withScenario } from "@thruputchain/testkit";
import { Airdrop } from "../src/contracts/generated/airdrop";
import { setup, storageFunding } from "./index";

const mocks = vi.hoisted(() => ({
  getBlockByHeight: vi.fn(),
  getNetworkInfo: vi.fn(),
  getChainConfig: vi.fn(),
  getBalance: vi.fn(),
  fund: vi.fn(),
  call: vi.fn(),
  deploy: vi.fn(),
  steps: [] as string[],
  stepMetadata: [] as unknown[],
  // Set to make the scenario fail when it saves its report on close.
  closeError: undefined as Error | undefined,
  link: vi.fn(),
  // Contract views by name. Each receives the view's readable arguments.
  views: {
    symbol: vi.fn(),
    decimals: vi.fn(),
    balance: vi.fn(),
    config: vi.fn(),
    eligible: vi.fn(),
  },
}));
const evidence: SubmissionEvidence = vi.hoisted(() => ({
  networkHash: new Uint8Array(32).fill(7),
  transactionHash: new Uint8Array(32).fill(9),
  signedTransaction: new Uint8Array([1, 2, 3]),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: mocks.link,
}));
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async () => ({
    network: { networkHash: new Uint8Array(32).fill(7) },
    getBlockByHeight: mocks.getBlockByHeight,
    getNetworkInfo: mocks.getNetworkInfo,
    getChainConfig: mocks.getChainConfig,
  })),
}));
// Unit tests check this app's steps and publication. Testkit's own tests cover
// transaction recording, and tests/e2e/airdrop.ts runs the real flow on a node.
vi.mock("@thruputchain/testkit", async (original) => ({
  ...(await original<typeof import("@thruputchain/testkit")>()),
  withScenario: vi.fn(async (options, run) => {
    const [name, account] = Object.entries(options.accounts)[0]!;
    // Like testkit, run the signing hook before each transaction is sent. A
    // failed hook stops the send, and testkit reports it as not submitted.
    const signed =
      (send: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          await options.onSigned?.(name, evidence);
        } catch (cause) {
          throw new ThruputError(
            "transactionNotSubmitted",
            "Transaction was not submitted",
            {
              cause,
              transaction: {
                hash: evidence.transactionHash,
                outcome: "notSubmitted",
                reason: "persistenceFailed",
                submission: evidence,
              },
            },
          );
        }
        return send(...args);
      };
    const actor = {
      account,
      wallet: { getBalance: mocks.getBalance },
      fund: mocks.fund,
      call: signed(mocks.call),
      deploy: signed(mocks.deploy),
    };
    const result = await run({
      // Like testkit, accept only the configured actor.
      actor: (actorName: string) => {
        if (actorName !== name)
          throw new Error(`Unknown scenario actor: ${actorName}`);
        return actor;
      },
      view: async (request: {
        view: keyof typeof mocks.views;
        args: unknown;
      }) => ({
        value: mocks.views[request.view](request.args),
      }),
      run: {
        report: () => ({ attempts: [] }),
        step: async (
          step: string,
          action: () => Promise<unknown>,
          stepOptions?: { metadata?: unknown },
        ) => {
          mocks.steps.push(step);
          mocks.stepMetadata.push(stepOptions?.metadata);
          return action();
        },
      },
    });
    // Testkit saves the report when the scenario closes, after the callback.
    if (mocks.closeError) throw mocks.closeError;
    return result;
  }),
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

// Tag each generated view request with its name and readable arguments.
function stubView(
  method: { viewRequest: (...args: never[]) => unknown },
  view: keyof typeof mocks.views,
) {
  vi.spyOn(method, "viewRequest").mockImplementation(
    (options: { args?: unknown }) => ({ view, args: options.args }) as never,
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.steps.length = 0;
  mocks.stepMetadata.length = 0;
  mocks.closeError = undefined;
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
  mocks.fund.mockResolvedValue({ rawAmount: 1_000_000_000n });
  mocks.call.mockResolvedValue({ receipt: {} });
  mocks.deploy.mockImplementation(async (deployment) => {
    deployedAddress = deployment.address;
    return { address: deployment.address };
  });
  mocks.link.mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).link,
  );
  stubView(ERC20Metadata.v0_1.symbol, "symbol");
  stubView(ERC20Metadata.v0_1.decimals, "decimals");
  stubView(ERC20.v0_1.getBalanceOf, "balance");
  stubView(Airdrop.v0_1.config, "config");
  stubView(Airdrop.v0_1.eligible, "eligible");
  mocks.views.symbol.mockReturnValue("TEST");
  mocks.views.decimals.mockReturnValue(6n);
  // The deployed airdrop holds the distributed rewards; the deployer holds more.
  mocks.views.balance.mockImplementation(({ addr }: { addr: Uint8Array }) =>
    deployedAddress && toBase58(addr) === toBase58(deployedAddress)
      ? 2_000_000n
      : 10_000_000n,
  );
  mocks.views.config.mockImplementation(() => ({
    restricted: false,
    rewards: initializer.rewards,
  }));
  mocks.views.eligible.mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function latestRun() {
  const [name] = await readdir(env.AIRDROP_SETUP_DIR!);
  return join(env.AIRDROP_SETUP_DIR!, name!);
}

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
  "uses the same atomic deployment and recorded steps for %s, with its Swap link",
  async (mode) => {
    await setup(env, mode);
    expect(mocks.steps).toEqual([
      "check-network",
      "verify-tokens",
      "deploy-airdrop",
      "storage-TEST",
      "distribute-TEST",
      "verify-airdrop",
    ]);
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.deploy).toHaveBeenCalledOnce();
    const [deployment, options] = mocks.deploy.mock.calls[0]!;
    expect(options.amount).toBe(storageFunding(costs, 2n, 0, 12).airdrop);
    expect(options.initializer.invocation).toEqual(
      Airdrop.v0_1.initialize.invocation(
        deployment.address,
        options.gasLimit,
        initializer,
      ),
    );
    expect(mocks.call).toHaveBeenCalledTimes(2);
    const scenario = vi.mocked(withScenario).mock.calls[0]![0];
    // The scenario is pinned to the discovered network.
    expect(scenario.network.cluster.networkHash).toEqual(
      new Uint8Array(32).fill(7),
    );
    expect(Object.keys(scenario.accounts)).toEqual(["Airdrop Deployer"]);
    // The check-network step records the block-one checkpoint.
    expect(mocks.stepMetadata[0]).toEqual({
      anchorHeight: "1",
      anchorHash: anchor,
    });
    const path = await latestRun();
    expect(scenario.runDirectory).toBe(join(path, "transactions"));
    // A supplied key stays with the caller; setup does not copy it to disk.
    expect(await readdir(path)).not.toContain("key.json");
    const output = await readFile(env.AIRDROP_ENV_PATH!, "utf8");
    expect(output).toContain(`AIRDROP_ANCHOR_HASH='${anchor}'`);
    expect(output).toContain(`THRUPUT_NETWORK_ID='${network}'`);
    expect(output).not.toContain(env.AIRDROP_DEPLOYER_PRIVATE_KEY);
    // Each mode links to its own Swap app.
    expect(output).toContain(
      mode === "local"
        ? "SWAP_APP_URL='http://127.0.0.1:5174/'"
        : "SWAP_APP_URL='https://examples.thruput.network/swap/'",
    );
    expect(
      vi.mocked(createThruputClient).mock.calls[0]![0]!.cluster,
    ).not.toHaveProperty("networkHash");
  },
);

it("publishes nothing when the report cannot be saved after a successful run", async () => {
  mocks.closeError = Object.assign(new Error("Report write failed"), {
    code: "EIO",
  });
  await expect(setup(env)).rejects.toBe(mocks.closeError);
  expect(mocks.steps.at(-1)).toBe("verify-airdrop");
  await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("stops at an uncertain deployment without later transactions or publication", async () => {
  mocks.deploy.mockRejectedValue(
    new ThruputError("transactionOutcomeUnknown", "Observation stopped", {
      context: {},
      transaction: {
        hash: evidence.transactionHash,
        outcome: "unknown",
        reason: "disconnected",
        submission: evidence,
      },
    }),
  );
  await expect(setup(env)).rejects.toMatchObject({
    code: "transactionOutcomeUnknown",
  });
  expect(mocks.deploy).toHaveBeenCalledOnce();
  expect(mocks.steps.at(-1)).toBe("deploy-airdrop");
  expect(mocks.call).not.toHaveBeenCalled();
  await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["network", "checkpoint"])(
  "rejects a changed %s before any transaction is sent",
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
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  },
);

it("checks the network in the signing hook before each broadcast", async () => {
  // The checkpoint changes after the initial check, just before the deployment is sent.
  mocks.views.symbol.mockImplementation(() => {
    mocks.getBlockByHeight.mockResolvedValue({ blockHash: new Uint8Array(32) });
    return "TEST";
  });
  await expect(setup(env)).rejects.toMatchObject({
    code: "transactionNotSubmitted",
    transaction: { outcome: "notSubmitted" },
    cause: { message: expect.stringMatching(/Network changed/) },
  });
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.fund).not.toHaveBeenCalled();
  expect(mocks.steps.at(-1)).toBe("deploy-airdrop");
});

it.each(["symbol", "decimals", "balance"] as const)(
  "rejects an existing token %s mismatch before funding",
  async (field) => {
    if (field === "symbol") mocks.views.symbol.mockReturnValueOnce("OTHER");
    if (field === "decimals") mocks.views.decimals.mockReturnValueOnce(7n);
    if (field === "balance") mocks.views.balance.mockReturnValueOnce(1n);
    await expect(setup(env)).rejects.toThrow(/metadata or deployer balance/);
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  },
);

it.each(["reward", "amount", "balance", "restricted"])(
  "rejects incorrect final %s before publishing",
  async (field) => {
    if (field === "reward")
      initializer.rewards[0]!.token = new Uint8Array(32).fill(5) as never;
    if (field === "amount") initializer.rewards[0]!.amount = 1n;
    if (field === "balance")
      mocks.views.balance.mockReturnValueOnce(10_000_000n).mockReturnValue(1n);
    if (field === "restricted")
      mocks.views.config.mockReturnValue({
        restricted: true,
        rewards: initializer.rewards,
      });
    await expect(setup(env)).rejects.toThrow(/mismatch/);
    await expect(readFile(env.AIRDROP_ENV_PATH!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("checks each allowlisted address after initialization", async () => {
  const path = join(directory, "addresses.json");
  await writeFile(path, JSON.stringify([toBase58(new Uint8Array(32).fill(3))]));
  mocks.views.config.mockReturnValue({
    restricted: true,
    rewards: initializer.rewards,
  });
  mocks.views.eligible.mockReturnValue(false);
  await expect(setup({ ...env, AIRDROP_ADDRESSES_FILE: path })).rejects.toThrow(
    /eligibility/,
  );
  expect(mocks.views.eligible).toHaveBeenCalledWith({
    address: new Uint8Array(32).fill(3),
  });
});

it("stops when a confirmed faucet response does not increase the observed balance", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  await expect(setup(env)).rejects.toThrow(/funding is not visible/);
  expect(mocks.fund).toHaveBeenCalledOnce();
  expect(mocks.deploy).not.toHaveBeenCalled();
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
  await expect(setup(env)).rejects.toMatchObject({ code: "EEXIST" });
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
