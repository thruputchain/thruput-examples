// @vitest-environment node
/// <reference types="node" />
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGroundhogClient,
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  toHex0x,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  contractAddress,
  gasAmount,
  HOG_ADDRESS,
} from "@groundhogchain/protocol";
import { StandardTokenFactory } from "../contracts/generated/standard-token-factory";
import { main, validateLocalRpcUrl } from "../../scripts/setup-local";
import { publishArtifact, validateTokenFunding } from "../../scripts/provision";
import { setupDevnet } from "../../scripts/setup-devnet";

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  requestAirdrop: vi.fn(),
  getBalance: vi.fn(),
  deployContractAndWait: vi.fn(),
  executeAndWait: vi.fn(),
  deriveContractAddress: vi.fn(),
  rename: vi.fn(),
  link: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rename: mocks.rename,
  link: mocks.link,
}));
vi.mock("@groundhogchain/client/wallet", async (original) => {
  const sdk = await original<typeof import("@groundhogchain/client/wallet")>();
  return {
    ...sdk,
    prepareContractDeployment: (
      input: Parameters<typeof sdk.prepareContractDeployment>[0],
    ) => ({
      ...sdk.prepareContractDeployment(input),
      address: mocks.deriveContractAddress(),
    }),
  };
});
vi.mock("@groundhogchain/client", async (original) => ({
  ...(await original<typeof import("@groundhogchain/client")>()),
  createGroundhogClient: vi.fn(async () => ({ getVersion: mocks.getVersion })),
  createWalletClient: vi.fn(() => mocks),
}));

const factory = contractAddress(new Uint8Array(32).fill(3));
const gas = gasAmount(10_000_000n);
const contract = (name: string) => ({
  contract_type: ContractType.kRv32 as const,
  rv32_contract: { data: new Uint8Array(Buffer.from(name)) },
});
const config = {
  token_code_hash: fixedBytes(hashContract(contract("standard_token")), 32),
  required_token_funding: 370_000n,
  native_token: HOG_ADDRESS,
  creation_fee: 0n,
  fee_recipient: null,
};
const costs = {
  hash: "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce",
  baseDataItemCost: "12000",
  bytestringCostPerByte: "10",
  baseContractDeploymentCost: "12000",
  contractDeploymentCostPerByte: "10",
  authPerKeyCost: "1111",
  rcqCostPerEntry: "8",
  replayCacheCostPerEntry: "7",
  balanceCost: "1234",
};
const manifestContents = (networkHash = `0x${"00".repeat(32)}`) => ({
  networkHash,
  bootstrap: { storageCostModel: costs },
});
let root: string;
let output: string;
let assetPath: string;
let oldAssetPath: string;
let phases: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "launchpad-setup-test-"));
  output = join(root, ".env.local");
  assetPath = join(
    root,
    "public/contract-artifacts",
    `${toHex0x(hashContract(contract("standard_token")))}.json`,
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
  vi.stubEnv("GROUNDHOG_RPC_URL", "http://127.0.0.1:9545");
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify(manifestContents()),
  );
  vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", join(root, "runtime.json"));
  vi.stubEnv("GROUNDHOG_NETWORK_ID", `0x${"00".repeat(32)}`);
  phases = [];
  mocks.getVersion.mockResolvedValue({ wireFormat: "4.0.0" });
  mocks.deriveContractAddress.mockReturnValue(factory);
  mocks.requestAirdrop.mockImplementation(async () => {
    phases.push("airdrop");
    return { status: { result: "ok" } };
  });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  mocks.deployContractAndWait.mockImplementation(async (deployment) => {
    phases.push("deploy");
    return { txHash: new Uint8Array(32), address: deployment.address };
  });
  mocks.executeAndWait.mockImplementation(async () => {
    phases.push("execute");
    return { txHash: new Uint8Array(32) };
  });
  vi.spyOn(StandardTokenFactory.v0_1.config, "view").mockResolvedValue({
    value: config,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("infrastructure-only launchpad provisioning", () => {
  it("provisions Devnet without a local manifest and verifies native balance bookkeeping", async () => {
    vi.stubEnv("GROUNDHOG_RPC_URL", undefined);
    vi.stubEnv("GROUNDHOG_NETWORK_ID", `0x${"11".repeat(32)}`);
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", "/unused-local-manifest.json");
    mocks.getBalance
      .mockResolvedValueOnce({ rawBalance: 1_000_000_000n })
      .mockResolvedValueOnce({ rawBalance: 10_000_000n - 1_234n });
    vi.mocked(StandardTokenFactory.v0_1.config.view).mockResolvedValueOnce({
      value: { ...config, required_token_funding: 10_000_000n },
    } as never);
    await setupDevnet();
    expect(createGroundhogClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({
          name: "devnet",
          rpcUrl: "https://rpc.thruput.network/",
          networkHash: new Uint8Array(32).fill(17),
        }),
      }),
    );
    expect(mocks.getBalance).toHaveBeenLastCalledWith(factory);
    const env = await readFile(output, "utf8");
    expect(env).toContain(
      "VITE_GROUNDHOG_RPC_URL=https://rpc.thruput.network/\n",
    );
    expect(env).toContain(
      "VITE_EXPLORER_URL=https://explorer.thruput.network\n",
    );
    expect(env).toContain("VITE_SWAP_APP_URL=\n");
    expect(env).not.toMatch(/PRIVATE|WALLET|SIGNER/);
  });

  it("refuses Devnet deployment when native balance bookkeeping does not match the app", async () => {
    mocks.getBalance
      .mockResolvedValueOnce({ rawBalance: 1_000_000_000n })
      .mockResolvedValueOnce({ rawBalance: 10_000_000n });
    await expect(
      setupDevnet({
        ...process.env,
        GROUNDHOG_RPC_URL: "https://rpc.example.com",
      }),
    ).rejects.toThrow(/balance bookkeeping cost/);
    expect(mocks.deployContractAndWait).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("previous environment\n");
  });

  it("rejects invalid Devnet targets and missing network pins before RPC", async () => {
    for (const rpcUrl of [
      "http://rpc.example.com",
      "https://user:secret@rpc.example.com",
      "https://rpc.example.com?token=secret",
      "https://rpc.example.com#fragment",
    ]) {
      await expect(
        setupDevnet({ ...process.env, GROUNDHOG_RPC_URL: rpcUrl }),
      ).rejects.toThrow(/HTTPS RPC URL/);
    }
    await expect(
      setupDevnet({
        ...process.env,
        GROUNDHOG_RPC_URL: "https://rpc.example.com",
        GROUNDHOG_NETWORK_ID: undefined,
      }),
    ).rejects.toThrow(/GROUNDHOG_NETWORK_ID/);
    expect(createGroundhogClient).not.toHaveBeenCalled();
  });
  it("supplies the RPC default and resolves relative overrides from the repository root", async () => {
    const repositoryRoot = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    vi.stubEnv("GROUNDHOG_RPC_URL", undefined);
    vi.stubEnv("LAUNCHPAD_ARTIFACT_ROOT", relative(repositoryRoot, root));
    vi.stubEnv("LAUNCHPAD_APP_ENV", relative(repositoryRoot, output));
    vi.stubEnv(
      "LAUNCHPAD_APP_PUBLIC_DIR",
      relative(repositoryRoot, join(root, "public")),
    );
    vi.stubEnv(
      "GROUNDHOG_RUNTIME_MANIFEST",
      relative(repositoryRoot, join(root, "runtime.json")),
    );
    await main();
    expect(await readFile(output, "utf8")).toContain(
      "VITE_GROUNDHOG_RPC_URL=http://127.0.0.1:9545/\n",
    );
    expect(JSON.parse(await readFile(assetPath, "utf8")).hash).toBe(
      toHex0x(hashContract(contract("standard_token"))),
    );
  });
  it("publishes concurrent different hashes without overwriting existing assets", async () => {
    const publications = await Promise.all(
      ["first code", "second code"].map(async (code, index) => {
        const hash = toHex0x(hashContract(contract(code)));
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

  it.each(Object.keys(costs))(
    "rejects changed or missing %s before funding",
    async (field) => {
      for (const value of ["99999", undefined]) {
        await writeFile(
          join(root, "runtime.json"),
          JSON.stringify({
            ...manifestContents(),
            bootstrap: { storageCostModel: { ...costs, [field]: value } },
          }),
        );
        await expect(main()).rejects.toThrow(field);
        expect(mocks.requestAirdrop).not.toHaveBeenCalled();
      }
    },
  );

  it("requires a runtime manifest and storage cost model", async () => {
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", "");
    await expect(main()).rejects.toThrow(/GROUNDHOG_RUNTIME_MANIFEST/);
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", join(root, "runtime.json"));
    await writeFile(
      join(root, "runtime.json"),
      JSON.stringify({ networkHash: "00".repeat(32) }),
    );
    await expect(main()).rejects.toThrow(/storageCostModel/);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
  });

  it("enforces the maximum token artifact size within 370000 funding", async () => {
    // 50914 fixed worst-case storage cost leaves room for 31908 code bytes.
    expect(() => validateTokenFunding(costs, 31_908)).not.toThrow();
    expect(() => validateTokenFunding(costs, 31_909)).toThrow(/funding budget/);
    await writeFile(join(root, "standard_token.rv32a"), Buffer.alloc(31_909));
    await expect(main()).rejects.toThrow(/funding budget/);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
  });
  it("deploys only a factory, funds before initialization, and writes public infrastructure only", async () => {
    await main();
    expect(phases).toEqual([
      "airdrop",
      "execute",
      "execute",
      "deploy",
      "execute",
    ]);
    expect(mocks.requestAirdrop).toHaveBeenCalledWith();
    const account = vi.mocked(createWalletClient).mock.calls[0]![0].account;
    expect(account.kind).toBe("pubkey");
    const [deployment, deployOptions, options] =
      mocks.deployContractAndWait.mock.calls[0]!;
    expect(deployment.contract).toEqual(contract("standard_token_factory"));
    expect(deployment.deployer).toEqual(account.address);
    expect(deployOptions).toEqual({ gasLimit: gas, amount: 0n });
    expect(options).toEqual({ timeoutMs: 60_000 });
    expect(
      mocks.executeAndWait.mock.calls.map(([request]) => request.invocation),
    ).toEqual([
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: HOG_ADDRESS,
        amount: 10_000_000n,
      }),
      ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
        receiver: factory,
        amount: 10_000_000n,
      }),
      StandardTokenFactory.v0_1.initialize.invocation(factory, gas, { config }),
    ]);
    const env = await readFile(output, "utf8");
    expect(
      env
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0]),
    ).toEqual([
      "VITE_GROUNDHOG_RPC_URL",
      "VITE_GROUNDHOG_NETWORK_ID",
      "VITE_NATIVE_HOG_ADDRESS",
      "VITE_NATIVE_BALANCE_ITEM_COST",
      "VITE_STANDARD_TOKEN_FACTORY_ADDRESS",
      "VITE_STANDARD_TOKEN_HASH",
    ]);
    expect(env).toContain("VITE_NATIVE_BALANCE_ITEM_COST=1234\n");
    expect(env).not.toMatch(
      /PRIVATE|PERSONA|WALLET|ENTRYPOINT|POOL|alice|bob|carol/i,
    );
    expect(env).not.toContain(toHex0x(account.address));
    const asset = JSON.parse(await readFile(assetPath, "utf8"));
    expect(asset).toEqual({
      contractType: "rv32",
      data: toHex0x(Buffer.from("standard_token")),
      hash: toHex0x(hashContract(contract("standard_token"))),
    });
    expect(asset.hash).toBe(
      toHex0x(
        hashContract({
          contract_type: ContractType.kRv32,
          rv32_contract: { data: fromHex0x(asset.data) },
        }),
      ),
    );
    expect(env).toContain(`VITE_STANDARD_TOKEN_HASH=${asset.hash}\n`);
    expect(
      mocks.rename.mock.calls.map(([, destination]) => destination),
    ).toEqual([output]);
    expect(mocks.link.mock.calls.map(([, destination]) => destination)).toEqual(
      [assetPath],
    );
  });

  it.each([
    "airdrop",
    "receipt",
    "address",
    "verification",
    "asset publication",
  ])("preserves existing output when %s fails", async (phase) => {
    if (phase === "airdrop")
      mocks.requestAirdrop.mockResolvedValueOnce({
        status: { result: "reverted" },
      });
    if (phase === "receipt")
      mocks.executeAndWait.mockRejectedValueOnce(new Error("Execution failed"));
    if (phase === "address")
      mocks.deployContractAndWait.mockRejectedValueOnce(
        new Error("Deployment address mismatch"),
      );
    if (phase === "verification")
      vi.mocked(StandardTokenFactory.v0_1.config.view).mockResolvedValueOnce({
        value: { ...config, creation_fee: 1n },
      } as never);
    if (phase === "asset publication")
      mocks.link.mockRejectedValueOnce(new Error("Cannot publish asset"));
    await expect(main()).rejects.toThrow();
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
          toHex0x(hashContract(contract("standard_token"))),
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

  it("accepts a cost-profile manifest without bootstrap users or faucet", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify(manifestContents()));
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
    await main();
    expect(mocks.deployContractAndWait).toHaveBeenCalledTimes(1);
  });

  it.each(["ab".repeat(32), `0x${"AB".repeat(32)}`, `0X${"ab".repeat(32)}`])(
    "normalizes manifest network hash %s",
    async (recorded) => {
      const manifest = join(root, "runtime.json");
      await writeFile(manifest, JSON.stringify(manifestContents(recorded)));
      vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
      vi.stubEnv("GROUNDHOG_NETWORK_ID", "AB".repeat(32));
      await main();
      expect(await readFile(output, "utf8")).toContain(
        `VITE_GROUNDHOG_NETWORK_ID=0x${"ab".repeat(32)}\n`,
      );
    },
  );

  it("rejects changed native costs before any funding", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(
      manifest,
      JSON.stringify({
        networkHash: `0x${"00".repeat(32)}`,
        bootstrap: { storageCostModel: { ...costs, balanceCost: "1235" } },
      }),
    );
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
    await expect(main()).rejects.toThrow(/balanceCost/);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
  });

  it("rejects invalid networks and old wire formats before funding", async () => {
    vi.stubEnv("GROUNDHOG_NETWORK_ID", "invalid");
    await expect(main()).rejects.toThrow(/network hash/);
    vi.stubEnv("GROUNDHOG_NETWORK_ID", `0x${"00".repeat(32)}`);
    mocks.getVersion.mockResolvedValueOnce({ wireFormat: "3.0.0" });
    await expect(main()).rejects.toThrow(/wire format/);
    expect(mocks.requestAirdrop).not.toHaveBeenCalled();
  });

  it("rejects nonlocal and credentialed RPC URLs", () => {
    for (const url of [
      "https://localhost",
      "http://example.com",
      "http://user:secret@localhost",
      "http://localhost?secret=token",
      "http://localhost#secret",
      "http://localhost?",
      "http://localhost#",
    ]) {
      expect(() => validateLocalRpcUrl(url)).toThrow(/loopback/);
    }
  });
});
