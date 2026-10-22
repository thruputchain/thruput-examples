// @vitest-environment node
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
  createThruputClient,
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  ContractType,
  contractAddress,
  gasAmount,
  HOG_ADDRESS,
} from "@thruputchain/protocol";
import { SwapFactory } from "../contracts/generated/swap-factory";
import { SwapRouter } from "../contracts/generated/swap-router";
import { main, validateLocalRpcUrl } from "../../scripts/setup-local";
import { publishArtifact } from "../../scripts/provision";
import { setupDevnet } from "../../scripts/setup-devnet";

const mocks = vi.hoisted(() => ({
  getVersionInfo: vi.fn(),
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
vi.mock("@thruputchain/client/wallet", async (original) => {
  const sdk = await original<typeof import("@thruputchain/client/wallet")>();
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
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async () => ({
    getVersionInfo: mocks.getVersionInfo,
  })),
  createWalletClient: vi.fn(() => mocks),
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const factory = address(3);
const router = address(4);
const gas = gasAmount(10_000_000n);
const artifactNames = [
  "erc20",
  "swap_factory",
  "swap_router",
  "swap_handler",
  "swap_driver",
];
const contract = (name: string) => ({
  contract_type: ContractType.kRv32 as const,
  rv32_contract: { data: new Uint8Array(Buffer.from(name)) },
});
let root: string;
let output: string;
let assetPath: string;
let oldAssetPath: string;
let phases: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "swap-setup-test-"));
  output = join(root, ".env.local");
  assetPath = join(
    root,
    "public/contract-artifacts",
    `${toBase58(hashContract(contract("erc20")))}.json`,
  );
  oldAssetPath = join(root, "public/contract-artifacts", `${b58(0x11)}.json`);
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
    artifactNames.map((name) => writeFile(join(root, `${name}.rv32a`), name)),
  );
  await writeFile(output, "previous environment\n");
  vi.stubEnv("SWAP_ARTIFACT_ROOT", root);
  vi.stubEnv("SWAP_APP_ENV", output);
  vi.stubEnv("SWAP_APP_PUBLIC_DIR", join(root, "public"));
  vi.stubEnv("THRUPUT_RPC_URL", "http://127.0.0.1:9545");
  vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", "");
  vi.stubEnv("THRUPUT_NETWORK_ID", b58(0x00));
  phases = [];
  mocks.getVersionInfo.mockResolvedValue({ wireFormat: "14.0.0" });
  mocks.requestAirdrop.mockImplementation(async () => {
    phases.push("airdrop");
    return { rawAmount: 1_000_000_000n };
  });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  mocks.deployContractAndWait.mockImplementation(async (deployment) => {
    phases.push("deploy");
    return { transactionHash: new Uint8Array(32), address: deployment.address };
  });
  mocks.executeAndWait.mockImplementation(async () => {
    phases.push("execute");
    return { transactionHash: new Uint8Array(32) };
  });
  const deployments = [address(1), address(2), factory, router];
  const predicted = [...deployments];
  mocks.deriveContractAddress.mockImplementation(() => predicted.shift()!);
  vi.spyOn(SwapFactory.v0_1.allPairsLength, "view").mockResolvedValue({
    value: 0n,
  } as never);
  vi.spyOn(SwapFactory.v0_1.poolFunding, "view").mockResolvedValue({
    value: { min: 1n, recommended: 2n },
  } as never);
  vi.spyOn(SwapFactory.v0_1.feeTo, "view").mockResolvedValue({
    value: null,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("infrastructure-only swap provisioning", () => {
  it("provisions Devnet with an explicit network pin and no local manifest or exported signer", async () => {
    vi.stubEnv("THRUPUT_RPC_URL", undefined);
    vi.stubEnv("THRUPUT_NETWORK_ID", b58(0x11));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", "/unused-local-manifest.json");
    await setupDevnet();
    expect(createThruputClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({
          name: "devnet",
          rpcUrl: "https://rpc.thruput.network/",
          networkHash: new Uint8Array(32).fill(17),
        }),
      }),
    );
    const env = await readFile(output, "utf8");
    expect(env).toContain(
      "VITE_THRUPUT_RPC_URL=https://rpc.thruput.network/\n",
    );
    expect(env).toContain(`VITE_THRUPUT_NETWORK_ID=${b58(0x11)}\n`);
    expect(env).toContain("VITE_TOKEN_DISCOVERY_ENABLED=false\n");
    expect(env).toContain(
      "VITE_EXPLORER_URL=https://explorer.thruput.network\n",
    );
    expect(env).not.toMatch(/PRIVATE|WALLET|SIGNER/);
    expect(mocks.deployContractAndWait).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid Devnet targets and missing network pins before RPC", async () => {
    for (const rpcUrl of [
      "http://rpc.example.com",
      "https://user:secret@rpc.example.com",
      "https://rpc.example.com?token=secret",
      "https://rpc.example.com#fragment",
    ]) {
      await expect(
        setupDevnet({ ...process.env, THRUPUT_RPC_URL: rpcUrl }),
      ).rejects.toThrow(/HTTPS RPC URL/);
    }
    await expect(
      setupDevnet({
        ...process.env,
        THRUPUT_RPC_URL: "https://rpc.example.com",
        THRUPUT_NETWORK_ID: undefined,
      }),
    ).rejects.toThrow(/THRUPUT_NETWORK_ID/);
    expect(createThruputClient).not.toHaveBeenCalled();
  });
  it("supplies the RPC default and resolves relative overrides from the repository root", async () => {
    const repositoryRoot = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    vi.stubEnv("THRUPUT_RPC_URL", undefined);
    vi.stubEnv("SWAP_ARTIFACT_ROOT", relative(repositoryRoot, root));
    vi.stubEnv("SWAP_APP_ENV", relative(repositoryRoot, output));
    vi.stubEnv(
      "SWAP_APP_PUBLIC_DIR",
      relative(repositoryRoot, join(root, "public")),
    );
    await main();
    expect(await readFile(output, "utf8")).toContain(
      "VITE_THRUPUT_RPC_URL=http://127.0.0.1:9545/\n",
    );
    expect(JSON.parse(await readFile(assetPath, "utf8")).hash).toBe(
      toBase58(hashContract(contract("erc20"))),
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
  it("registers only handler/driver instances, deploys/funds/initializes infrastructure, and publishes no accounts or pools", async () => {
    await main();
    expect(phases).toEqual([
      "airdrop",
      "execute",
      "execute",
      "deploy",
      "execute",
      "deploy",
      "execute",
      "deploy",
      "execute",
      "deploy",
      "execute",
      "execute",
    ]);
    expect(mocks.requestAirdrop).toHaveBeenCalledWith();
    const account = vi.mocked(createWalletClient).mock.calls[0]![0].account;
    expect(account.kind).toBe("pubkey");
    expect(
      mocks.deployContractAndWait.mock.calls.map(
        ([deployment]) => deployment.contract,
      ),
    ).toEqual(
      ["swap_handler", "swap_driver", "swap_factory", "swap_router"].map(
        (name) => contract(name),
      ),
    );
    for (const [deployment, deployOptions, options] of mocks
      .deployContractAndWait.mock.calls) {
      expect(deployment.deployer).toEqual(account.address);
      expect(deployOptions).toEqual({ gasLimit: gas, amount: 0n });
      expect(options).toEqual({ timeoutMs: 60_000 });
    }
    expect(
      mocks.executeAndWait.mock.calls.map(([request]) => request.invocation),
    ).toEqual([
      ...[HOG_ADDRESS, address(1), address(2), factory, router].map(
        (receiver) =>
          ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gas, {
            receiver,
            amount: 10_000_000n,
          }),
      ),
      SwapFactory.v0_1.initialize.invocation(factory, gas, {
        hashes: {
          token: fixedBytes(hashContract(contract("erc20")), 32),
          handler: fixedBytes(hashContract(contract("swap_handler")), 32),
          driver: fixedBytes(hashContract(contract("swap_driver")), 32),
        },
        feeTo: null,
        router,
      }),
      SwapRouter.v0_1.initialize.invocation(router, gas, { factory }),
    ]);
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
      "VITE_SWAP_FACTORY_ADDRESS",
      "VITE_SWAP_ROUTER_ADDRESS",
      "VITE_POOL_TOKEN_HASH",
    ]);
    expect(env).not.toMatch(
      /PRIVATE|PERSONA|WALLET|ENTRYPOINT|POOL_ADDRESS|LIQUIDITY|DRIVER|alice|bob|carol/i,
    );
    expect(env).not.toContain(toBase58(account.address));
    expect(await readdir(root)).not.toContain("thruput");
    const asset = JSON.parse(await readFile(assetPath, "utf8"));
    expect(asset).toEqual({
      contractType: "rv32",
      data: toHex0x(Buffer.from("erc20")),
      hash: toBase58(hashContract(contract("erc20"))),
    });
    expect(asset.hash).toBe(
      toBase58(
        hashContract({
          contract_type: ContractType.kRv32,
          rv32_contract: { data: fromHex0x(asset.data) },
        }),
      ),
    );
    expect(env).toContain(`VITE_POOL_TOKEN_HASH=${asset.hash}\n`);
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
    "fee recipient",
    "asset publication",
  ])("preserves existing output when %s fails", async (phase) => {
    if (phase === "airdrop")
      mocks.requestAirdrop.mockRejectedValueOnce(new Error("Funding stopped"));
    if (phase === "receipt")
      mocks.executeAndWait.mockRejectedValueOnce(new Error("Execution failed"));
    if (phase === "address")
      mocks.deployContractAndWait.mockRejectedValueOnce(
        new Error("Deployment address mismatch"),
      );
    if (phase === "verification")
      vi.mocked(SwapFactory.v0_1.allPairsLength.view).mockResolvedValueOnce({
        value: 1n,
      } as never);
    if (phase === "asset publication")
      mocks.link.mockRejectedValueOnce(new Error("Cannot publish asset"));
    if (phase === "fee recipient")
      vi.mocked(SwapFactory.v0_1.feeTo.view).mockResolvedValueOnce({
        value: address(99),
      } as never);
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
          toBase58(hashContract(contract("erc20"))),
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

  it("accepts a network-only manifest without bootstrap personas", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify({ networkHash: b58(0x00) }));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
    await main();
    expect(createThruputClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({ networkHash: new Uint8Array(32) }),
      }),
    );
  });

  it("writes the base58 manifest network hash", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify({ networkHash: b58(0xab) }));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
    vi.stubEnv("THRUPUT_NETWORK_ID", b58(0xab));
    await main();
    expect(await readFile(output, "utf8")).toContain(
      `VITE_THRUPUT_NETWORK_ID=${b58(0xab)}\n`,
    );
  });

  it.each(["ab".repeat(32), `0x${"ab".repeat(32)}`, ` ${b58(0xab)}`])(
    "rejects a noncanonical manifest network hash %s",
    async (recorded) => {
      const manifest = join(root, "runtime.json");
      await writeFile(manifest, JSON.stringify({ networkHash: recorded }));
      vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
      await expect(main()).rejects.toThrow(/network hash/);
      expect(createThruputClient).not.toHaveBeenCalled();
    },
  );

  it("rejects mismatched network pins and unsupported wire formats before funding", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(manifest, JSON.stringify({ networkHash: b58(0x11) }));
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", manifest);
    await expect(main()).rejects.toThrow(/disagree/);
    vi.stubEnv("THRUPUT_RUNTIME_MANIFEST", "");
    mocks.getVersionInfo.mockResolvedValueOnce({ wireFormat: "13.0.0" });
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
