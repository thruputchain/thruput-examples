// @vitest-environment node
/// <reference types="node" />
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
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThruputClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  gasAmount,
  NATIVE_TOKEN_ADDRESS,
} from "@thruputchain/protocol";
import { StandardTokenFactory } from "../src/contracts/generated/standard-token-factory";
import { loadKeyFile, withScenario } from "@thruputchain/testkit";
import { setup as main, publishArtifact, validateTokenFunding } from "./index";
const setupDevnet = (env = process.env) => main(env, "devnet");

const mocks = vi.hoisted(() => ({
  getVersionInfo: vi.fn(),
  getChainConfig: vi.fn(),
  fund: vi.fn(),
  getBalance: vi.fn(),
  call: vi.fn(),
  deploy: vi.fn(),
  view: vi.fn(),
  steps: [] as string[],
  stepMetadata: [] as unknown[],
  rename: vi.fn(),
  link: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rename: mocks.rename,
  link: mocks.link,
}));
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async ({ cluster }) => ({
    network: { networkHash: cluster.networkHash ?? new Uint8Array(32).fill(7) },
    getVersionInfo: mocks.getVersionInfo,
    getChainConfig: mocks.getChainConfig,
  })),
}));
// Unit tests check this app's steps and publication. Testkit's own tests cover
// transaction recording, and setup.integration.ts runs the real flow on a node.
vi.mock("@thruputchain/testkit", async (original) => ({
  ...(await original<typeof import("@thruputchain/testkit")>()),
  withScenario: vi.fn(async (options, run) => {
    const [account] = Object.values(options.accounts);
    const actor = {
      account,
      wallet: { getBalance: mocks.getBalance },
      fund: mocks.fund,
      call: mocks.call,
      deploy: mocks.deploy,
    };
    return run({
      // Like testkit, accept only the configured actor.
      actor: (name: string) => {
        if (!(name in options.accounts))
          throw new Error(`Unknown scenario actor: ${name}`);
        return actor;
      },
      view: mocks.view,
      run: {
        report: () => ({ attempts: [] }),
        step: async (
          name: string,
          action: () => Promise<unknown>,
          stepOptions?: { metadata?: unknown },
        ) => {
          mocks.steps.push(name);
          mocks.stepMetadata.push(stepOptions?.metadata);
          return action();
        },
      },
    });
  }),
}));

const gas = gasAmount(10_000_000n);
const contract = (name: string) => ({
  contract_type: ContractType.kRv32 as const,
  rv32_contract: { data: new Uint8Array(Buffer.from(name)) },
});
const config = {
  token_code_hash: fixedBytes(hashContract(contract("standard_token")), 32),
  required_token_funding: 1_000_000n,
  native_token: NATIVE_TOKEN_ADDRESS,
  creation_fee: 0n,
  fee_recipient: null,
};
const costs = {
  baseDataItemCost: 12000n,
  bytestringCostPerByte: 10n,
  baseContractDeploymentCost: 12000n,
  contractDeploymentCostPerByte: 10n,
  authPerKeyCost: 1111n,
  rcqCostPerEntry: 8n,
  replayCacheCostPerEntry: 7n,
  balanceCost: 1234n,
};
const zeroNetwork = toBase58(new Uint8Array(32));
const manifestContents = (networkHash = zeroNetwork) => ({
  networkHash,
});
let root: string;
let output: string;
let assetPath: string;
let oldAssetPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "launchpad-setup-test-"));
  output = join(root, ".env.local");
  assetPath = join(
    root,
    "public/contract-artifacts",
    `${toBase58(hashContract(contract("standard_token")))}.json`,
  );
  oldAssetPath = join(
    root,
    "public/contract-artifacts",
    `0x${"11".repeat(32)}.json`,
  );
  await mkdir(join(root, "public/contract-artifacts"), { recursive: true });
  await writeFile(oldAssetPath, "previous artifact\n");
  mocks.link.mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).link,
  );
  mocks.rename.mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).rename,
  );
  await Promise.all(
    ["standard_token", "standard_token_factory"].map((name) =>
      writeFile(join(root, `${name}.rv32a`), name),
    ),
  );
  await writeFile(output, "previous environment\n");
  vi.stubEnv("LAUNCHPAD_ARTIFACT_ROOT", root);
  vi.stubEnv("LAUNCHPAD_APP_ENV", output);
  vi.stubEnv("LAUNCHPAD_APP_PUBLIC_DIR", join(root, "public"));
  vi.stubEnv("THRUPUT_RPC_URL", "http://127.0.0.1:9545");
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify(manifestContents()),
  );
  vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", join(root, "runtime.json"));
  vi.stubEnv("THRUPUT_NETWORK_ID", zeroNetwork);
  mocks.steps.length = 0;
  mocks.stepMetadata.length = 0;
  mocks.getVersionInfo.mockResolvedValue({ wireFormat: "14.0.0" });
  mocks.getChainConfig.mockResolvedValue({
    execution: { storageCosts: costs },
  });
  mocks.fund.mockResolvedValue({ rawAmount: 1_000_000_000n });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  mocks.call.mockResolvedValue({});
  mocks.deploy.mockImplementation(async (deployment) => ({
    address: deployment.address,
  }));
  mocks.view.mockResolvedValue({ value: config });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("infrastructure-only launchpad provisioning", () => {
  it("provisions Devnet without a manifest and checks costs from the node", async () => {
    vi.stubEnv("THRUPUT_RPC_URL", undefined);
    vi.stubEnv("THRUPUT_NETWORK_ID", toBase58(new Uint8Array(32).fill(0x11)));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", undefined);
    mocks.view.mockResolvedValueOnce({
      value: { ...config, required_token_funding: 10_000_000n },
    });
    await setupDevnet();
    expect(createThruputClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({
          name: "devnet",
          rpcUrl: "https://rpc.thruput.network",
          networkHash: new Uint8Array(32).fill(17),
        }),
      }),
    );
    expect(mocks.getChainConfig).toHaveBeenCalledOnce();
    const env = await readFile(output, "utf8");
    expect(env).toContain("VITE_THRUPUT_RPC_URL=https://rpc.thruput.network\n");
    expect(env).toContain(
      "VITE_EXPLORER_URL=https://explorer.thruput.network\n",
    );
    expect(env).toContain("VITE_SWAP_APP_URL=\n");
    expect(env).not.toMatch(/PRIVATE|WALLET|SIGNER/);
  });

  it("refuses Devnet deployment when native balance bookkeeping does not match the app", async () => {
    mocks.getChainConfig.mockResolvedValueOnce({
      execution: { storageCosts: { ...costs, balanceCost: 1235n } },
    });
    await expect(
      setupDevnet({
        ...process.env,
        THRUPUT_RPC_URL: "https://rpc.example.com",
      }),
    ).rejects.toThrow(/balanceCost/);
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("previous environment\n");
  });

  it("discovers an unpinned network without a manifest", async () => {
    await main({
      ...process.env,
      THRUPUT_RUNTIME_MANIFEST: undefined,
      THRUPUT_NETWORK_ID: undefined,
    });
    expect(
      vi.mocked(createThruputClient).mock.calls[0]![0]!.cluster,
    ).not.toHaveProperty("networkHash");
    expect(await readFile(output, "utf8")).toContain(
      `VITE_THRUPUT_NETWORK_ID=${toBase58(new Uint8Array(32).fill(7))}\n`,
    );
  });
  it("supplies the RPC default and resolves relative overrides from the repository root", async () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    vi.stubEnv("THRUPUT_RPC_URL", undefined);
    vi.stubEnv("LAUNCHPAD_ARTIFACT_ROOT", relative(repositoryRoot, root));
    vi.stubEnv("LAUNCHPAD_APP_ENV", relative(repositoryRoot, output));
    vi.stubEnv(
      "LAUNCHPAD_APP_PUBLIC_DIR",
      relative(repositoryRoot, join(root, "public")),
    );
    vi.stubEnv(
      "THRUPUT_RUNTIME_MANIFEST",
      relative(repositoryRoot, join(root, "runtime.json")),
    );
    await main();
    expect(await readFile(output, "utf8")).toContain(
      "VITE_THRUPUT_RPC_URL=http://127.0.0.1:9545\n",
    );
    expect(JSON.parse(await readFile(assetPath, "utf8")).hash).toBe(
      toBase58(hashContract(contract("standard_token"))),
    );
  });
  it("publishes concurrent different hashes without overwriting existing assets", async () => {
    const publications = await Promise.all(
      ["first code", "second code"].map(async (code, index) => {
        const hash = toBase58(hashContract(contract(code)));
        const destination = join(
          root,
          "public/contract-artifacts",
          `${hash}.json`,
        );
        const temporary = join(root, `code-${index}.tmp`);
        const contents = JSON.stringify({
          contractType: "rv32",
          data: toHex0x(Buffer.from(code)),
          hash,
        });
        await writeFile(temporary, contents);
        return { temporary, destination, contents };
      }),
    );
    await Promise.all(
      publications.map(({ temporary, destination }) =>
        publishArtifact(temporary, destination),
      ),
    );
    for (const { temporary, destination, contents } of publications) {
      await publishArtifact(temporary, destination);
      expect(await readFile(destination, "utf8")).toBe(contents);
      await rm(temporary);
      await writeFile(temporary, "different content");
      await expect(publishArtifact(temporary, destination)).rejects.toThrow(
        /different contents/,
      );
      expect(await readFile(destination, "utf8")).toBe(contents);
    }
    expect(await readFile(oldAssetPath, "utf8")).toBe("previous artifact\n");
  });

  it("rejects a manifest that disagrees with the network pin", async () => {
    vi.stubEnv("THRUPUT_NETWORK_ID", toBase58(new Uint8Array(32).fill(1)));
    await expect(main()).rejects.toThrow(/disagree/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("calculates storage with current costs instead of pinning unrelated fields", () => {
    expect(() =>
      validateTokenFunding({ ...costs, authPerKeyCost: 999n }, 36_908),
    ).not.toThrow();
    expect(() =>
      validateTokenFunding(
        { ...costs, contractDeploymentCostPerByte: 11n },
        36_908,
      ),
    ).toThrow(/funding budget/);
  });

  it("stops before funding if execution costs are unavailable", async () => {
    mocks.getChainConfig.mockResolvedValueOnce({});
    await expect(main()).rejects.toThrow(/storage costs/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("stops before deployment when faucet funding is insufficient", async () => {
    mocks.getBalance.mockResolvedValueOnce({ rawBalance: 1n });
    await expect(main()).rejects.toThrow(/reserve/);
    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("previous environment\n");
  });

  it("enforces the maximum token artifact size within 420000 funding", async () => {
    // 50914 fixed worst-case storage cost leaves room for 36908 code bytes.
    expect(() => validateTokenFunding(costs, 36_908)).not.toThrow();
    expect(() => validateTokenFunding(costs, 36_909)).toThrow(/funding budget/);
    await writeFile(join(root, "standard_token.rv32a"), Buffer.alloc(36_909));
    await expect(main()).rejects.toThrow(/funding budget/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });
  it("deploys only a factory, funds before initialization, and writes public infrastructure only", async () => {
    await main();
    expect(mocks.steps).toEqual([
      "fund-deployer",
      "fund-native-reserve",
      "deploy-factory",
      "verify-factory",
    ]);
    expect(mocks.fund).toHaveBeenCalledWith({ timeoutMs: 60_000 });
    const scenario = vi.mocked(withScenario).mock.calls[0]![0];
    // The scenario is pinned to the discovered network.
    const discovered =
      await vi.mocked(createThruputClient).mock.results[0]!.value;
    expect(scenario.network.cluster.networkHash).toEqual(
      discovered.network.networkHash,
    );
    const account = scenario.accounts["Launchpad Deployer"]!;
    expect(account.kind).toBe("pubkey");
    // Each run gets a new directory with a private key and the testkit report.
    const runs = join(root, ".local/launchpad-setup");
    const [name] = await readdir(runs);
    const directory = join(runs, name!);
    expect(scenario.runDirectory).toBe(join(directory, "transactions"));
    expect((await loadKeyFile(join(directory, "key.json"))).address).toBe(
      toBase58(account.address),
    );
    expect((await stat(join(directory, "key.json"))).mode & 0o777).toBe(0o600);

    const [calls, callOptions] = mocks.call.mock.calls[0]!;
    expect(
      calls.map((call: { invocation: unknown }) => call.invocation),
    ).toEqual([
      ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, gas, {
        receiver: NATIVE_TOKEN_ADDRESS,
        amount: 10_000_000n,
      }),
    ]);
    expect(callOptions).toEqual({ wait: { timeoutMs: 60_000 } });
    const [deployment, deployOptions] = mocks.deploy.mock.calls[0]!;
    // The deployment step records the predicted factory address.
    expect(mocks.stepMetadata[2]).toEqual({
      address: toBase58(deployment.address),
    });
    expect(deployment.contract).toEqual(contract("standard_token_factory"));
    expect(deployment.deployer).toEqual(account.address);
    expect(deployOptions.gasLimit).toBe(gas);
    expect(deployOptions.amount).toBe(10_000_000n);
    expect(deployOptions.wait).toEqual({ timeoutMs: 60_000 });
    expect(deployOptions.initializer.invocation).toEqual(
      StandardTokenFactory.v0_1.initialize.invocation(deployment.address, gas, {
        config,
      }),
    );
    expect(mocks.view.mock.calls[0]![0].request).toEqual(
      StandardTokenFactory.v0_1.config.viewRequest({
        address: deployment.address,
      }).request,
    );

    const env = await readFile(output, "utf8");
    expect(
      env
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0]),
    ).toEqual([
      "VITE_THRUPUT_RPC_URL",
      "VITE_THRUPUT_NETWORK_ID",
      "VITE_NATIVE_TOKEN_ADDRESS",
      "VITE_NATIVE_BALANCE_ITEM_COST",
      "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
      "VITE_STANDARD_TOKEN_HASH",
    ]);
    expect(env).toContain("VITE_NATIVE_BALANCE_ITEM_COST=1234\n");
    expect(env).toContain(
      `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toBase58(deployment.address)}\n`,
    );
    expect(env).not.toMatch(
      /PRIVATE|PERSONA|WALLET|ENTRYPOINT|POOL|alice|bob|carol/i,
    );
    expect(env).not.toContain(toBase58(account.address));
    const key = JSON.parse(await readFile(join(directory, "key.json"), "utf8"));
    expect(env).not.toContain(key.seed);
    const asset = JSON.parse(await readFile(assetPath, "utf8"));
    expect(asset).toEqual({
      contractType: "rv32",
      data: toHex0x(Buffer.from("standard_token")),
      hash: toBase58(hashContract(contract("standard_token"))),
    });
    expect(asset.hash).toBe(
      toBase58(
        hashContract({
          contract_type: ContractType.kRv32,
          rv32_contract: { data: fromHex0x(asset.data) },
        }),
      ),
    );
    expect(env).toContain(`VITE_STANDARD_TOKEN_HASH=${asset.hash}\n`);
    expect(
      mocks.rename.mock.calls.some(([, destination]) => destination === output),
    ).toBe(true);
    expect(mocks.link.mock.calls.map(([, destination]) => destination)).toEqual(
      [assetPath],
    );
  });

  it.each([
    "fund-deployer",
    "fund-native-reserve",
    "deploy-factory",
    "verify-factory",
    "asset publication",
  ] as const)("preserves existing output when %s fails", async (phase) => {
    if (phase === "fund-deployer")
      mocks.fund.mockRejectedValueOnce(new Error("Funding stopped"));
    if (phase === "fund-native-reserve")
      mocks.call.mockRejectedValueOnce(new Error("Execution failed"));
    if (phase === "deploy-factory")
      mocks.deploy.mockRejectedValueOnce(
        new Error("Deployment address mismatch"),
      );
    if (phase === "verify-factory")
      mocks.view.mockResolvedValueOnce({
        value: { ...config, creation_fee: 1n },
      });
    if (phase === "asset publication")
      mocks.link.mockRejectedValueOnce(new Error("Cannot publish asset"));
    // Each phase stops setup for its own reason.
    const reasons = {
      "fund-deployer": "Funding stopped",
      "fund-native-reserve": "Execution failed",
      "deploy-factory": "Deployment address mismatch",
      "verify-factory": "could not be verified",
      "asset publication": "Cannot publish asset",
    };
    await expect(main()).rejects.toThrow(reasons[phase]);
    expect(await readFile(output, "utf8")).toBe("previous environment\n");
    expect(await readFile(oldAssetPath, "utf8")).toBe("previous artifact\n");
    expect(await readdir(join(root, "public/contract-artifacts"))).toEqual([
      basename(oldAssetPath),
    ]);
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("publishes complete code before the environment and preserves old env if its rename fails", async () => {
    const { rename } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    mocks.rename.mockImplementation(async (source, destination) => {
      expect(await readFile(output, "utf8")).toBe("previous environment\n");
      if (destination === output) {
        expect(JSON.parse(await readFile(assetPath, "utf8")).hash).toBe(
          toBase58(hashContract(contract("standard_token"))),
        );
        throw new Error("Cannot publish environment");
      }
      await rename(source, destination);
    });
    await expect(main()).rejects.toThrow("Cannot publish environment");
    expect(await readFile(output, "utf8")).toBe("previous environment\n");
    expect(await readFile(oldAssetPath, "utf8")).toBe("previous artifact\n");
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(
      (await readdir(join(root, "public/contract-artifacts"))).sort(),
    ).toEqual([basename(oldAssetPath), basename(assetPath)].sort());
  });

  it("accepts a network-only manifest", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify(manifestContents()));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
    await main();
    expect(mocks.deploy).toHaveBeenCalledTimes(1);
  });

  it("records the manifest network hash exactly", async () => {
    const recorded = toBase58(new Uint8Array(32).fill(0xab));
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify(manifestContents(recorded)));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
    vi.stubEnv("THRUPUT_NETWORK_ID", recorded);
    await main();
    expect(await readFile(output, "utf8")).toContain(
      `VITE_THRUPUT_NETWORK_ID=${recorded}\n`,
    );
  });

  it.each([`0x${"00".repeat(32)}`, "00".repeat(32)])(
    "requires a base58 manifest network hash instead of %s",
    async (recorded) => {
      const manifest = join(root, "runtime.json");
      await writeFile(manifest, JSON.stringify(manifestContents(recorded)));
      vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
      await expect(main()).rejects.toThrow(/base58/i);
      expect(mocks.fund).not.toHaveBeenCalled();
    },
  );

  it("rejects changed native costs before any funding", async () => {
    mocks.getChainConfig.mockResolvedValueOnce({
      execution: { storageCosts: { ...costs, balanceCost: 1235n } },
    });
    await expect(main()).rejects.toThrow(/balanceCost/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("checks the public folder before any transaction", async () => {
    // A file where the asset folder should be cannot hold the code asset.
    const blocked = join(root, "blocked");
    await writeFile(blocked, "");
    vi.stubEnv("LAUNCHPAD_APP_PUBLIC_DIR", blocked);
    await expect(main()).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.steps).toEqual([]);
  });
  it("rejects invalid networks and unsupported wire formats before funding", async () => {
    vi.stubEnv("THRUPUT_NETWORK_ID", "invalid");
    await expect(main()).rejects.toThrow(/base58/);
    vi.stubEnv("THRUPUT_NETWORK_ID", zeroNetwork);
    mocks.getVersionInfo.mockResolvedValueOnce({ wireFormat: "13.0.0" });
    await expect(main()).rejects.toThrow(/wire format/);
    expect(mocks.fund).not.toHaveBeenCalled();
  });
});
