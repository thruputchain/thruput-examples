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
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGroundhogClient,
  createWalletClient,
  fixedBytes,
  fromHex0x,
  hashContract,
  toHex0x,
} from "@groundhogchain/client";
import { DefaultWallet, ERC20 } from "@groundhogchain/client/contracts";
import {
  ContractType,
  ExecResult,
  contractAddress,
  gasAmount,
  HOG_ADDRESS,
} from "@groundhogchain/protocol";
import { SwapFactory } from "../contracts/generated/swap-factory";
import { SwapRouter } from "../contracts/generated/swap-router";
import {
  main,
  publishArtifact,
  validateLocalRpcUrl,
} from "../../scripts/setup-local";

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  requestAirdrop: vi.fn(),
  getBalance: vi.fn(),
  sendInvocation: vi.fn(),
  execute: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  deriveContractAddress: vi.fn(),
  rename: vi.fn(),
  link: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rename: mocks.rename,
  link: mocks.link,
}));
vi.mock("@groundhogchain/client/contract", async (original) => ({
  ...(await original<typeof import("@groundhogchain/client/contract")>()),
  deriveContractAddress: mocks.deriveContractAddress,
}));
vi.mock("@groundhogchain/client", async (original) => ({
  ...(await original<typeof import("@groundhogchain/client")>()),
  createGroundhogClient: vi.fn(async () => ({ getVersion: mocks.getVersion })),
  createWalletClient: vi.fn(() => mocks),
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
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
  rv32_contract: { data: Buffer.from(name) },
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
    `${toHex0x(hashContract(contract("erc20")))}.json`,
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
    artifactNames.map((name) => writeFile(join(root, `${name}.rv32a`), name)),
  );
  await writeFile(output, "previous environment\n");
  vi.stubEnv("SWAP_ARTIFACT_ROOT", root);
  vi.stubEnv("SWAP_APP_ENV", output);
  vi.stubEnv("SWAP_APP_PUBLIC_DIR", join(root, "public"));
  vi.stubEnv("GROUNDHOG_RPC_URL", "http://127.0.0.1:9545");
  vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", "");
  vi.stubEnv("GROUNDHOG_NETWORK_ID", `0x${"00".repeat(32)}`);
  phases = [];
  mocks.getVersion.mockResolvedValue({ wireFormat: "4.0.0" });
  mocks.requestAirdrop.mockImplementation(async () => {
    phases.push("airdrop");
    return { status: { result: "ok" } };
  });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  mocks.sendInvocation.mockImplementation(async () => {
    phases.push("deploy");
    return new Uint8Array(32);
  });
  mocks.execute.mockImplementation(async () => {
    phases.push("execute");
    return new Uint8Array(32);
  });
  mocks.waitForTransactionReceipt.mockResolvedValue({
    execResult: ExecResult.ExecResultOK,
  });
  const deployments = [address(1), address(2), factory, router];
  const predicted = [...deployments];
  mocks.deriveContractAddress.mockImplementation(() => predicted.shift()!);
  vi.spyOn(DefaultWallet.deploy, "decodeReceipt").mockImplementation(
    () => ({ value: deployments.shift()! }) as never,
  );
  vi.spyOn(SwapFactory.allPairsLength, "view").mockResolvedValue({
    value: 0n,
  } as never);
  vi.spyOn(SwapFactory.poolFunding, "view").mockResolvedValue({
    value: { min: 1n, recommended: 2n },
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
      mocks.sendInvocation.mock.calls.map(
        ([request]) => request.contractsToDeploy,
      ),
    ).toEqual(
      ["swap_handler", "swap_driver", "swap_factory", "swap_router"].map(
        (name) => [contract(name)],
      ),
    );
    for (const [request] of mocks.sendInvocation.mock.calls) {
      expect(request.invocation.invoked_address).toEqual(account.address);
      expect(request.invocation.entrypoint).toEqual(
        DefaultWallet.deploy.entrypoint,
      );
    }
    expect(
      mocks.execute.mock.calls.map(([request]) => request.invocation),
    ).toEqual([
      ...[HOG_ADDRESS, address(1), address(2), factory, router].map(
        (receiver) =>
          ERC20.transfer.invocation(HOG_ADDRESS, gas, {
            receiver,
            amount: 10_000_000n,
          }),
      ),
      SwapFactory.initialize.invocation(factory, gas, {
        hashes: {
          token: fixedBytes(hashContract(contract("erc20")), 32),
          handler: fixedBytes(hashContract(contract("swap_handler")), 32),
          driver: fixedBytes(hashContract(contract("swap_driver")), 32),
        },
        feeTo: null,
        router,
      }),
      SwapRouter.initialize.invocation(router, gas, { factory }),
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
      "VITE_SWAP_FACTORY_ADDRESS",
      "VITE_SWAP_ROUTER_ADDRESS",
      "VITE_POOL_TOKEN_HASH",
    ]);
    expect(env).not.toMatch(
      /PRIVATE|PERSONA|WALLET|ENTRYPOINT|POOL_ADDRESS|LIQUIDITY|DRIVER|alice|bob|carol/i,
    );
    expect(env).not.toContain(toHex0x(account.address));
    expect(await readdir(root)).not.toContain("groundhog");
    const asset = JSON.parse(await readFile(assetPath, "utf8"));
    expect(asset).toEqual({
      contractType: "rv32",
      data: toHex0x(Buffer.from("erc20")),
      hash: toHex0x(hashContract(contract("erc20"))),
    });
    expect(asset.hash).toBe(
      toHex0x(
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
    "asset publication",
  ])("preserves existing output when %s fails", async (phase) => {
    if (phase === "airdrop")
      mocks.requestAirdrop.mockResolvedValueOnce({
        status: { result: "reverted" },
      });
    if (phase === "receipt")
      mocks.waitForTransactionReceipt.mockResolvedValueOnce({
        execResult: -1,
      });
    if (phase === "address")
      vi.mocked(DefaultWallet.deploy.decodeReceipt).mockReturnValueOnce({
        value: address(99),
      } as never);
    if (phase === "verification")
      vi.mocked(SwapFactory.allPairsLength.view).mockResolvedValueOnce({
        value: 1n,
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
          toHex0x(hashContract(contract("erc20"))),
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
    await writeFile(
      manifest,
      JSON.stringify({ networkHash: `0x${"00".repeat(32)}` }),
    );
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
    await main();
    expect(createGroundhogClient).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: expect.objectContaining({ networkHash: new Uint8Array(32) }),
      }),
    );
  });

  it.each(["ab".repeat(32), `0x${"AB".repeat(32)}`, `0X${"ab".repeat(32)}`])(
    "normalizes manifest network hash %s",
    async (recorded) => {
      const manifest = join(root, "runtime.json");
      await writeFile(manifest, JSON.stringify({ networkHash: recorded }));
      vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
      vi.stubEnv("GROUNDHOG_NETWORK_ID", "AB".repeat(32));
      await main();
      expect(await readFile(output, "utf8")).toContain(
        `VITE_GROUNDHOG_NETWORK_ID=0x${"ab".repeat(32)}\n`,
      );
    },
  );

  it("rejects mismatched network pins and unsupported wire formats before funding", async () => {
    const manifest = join(root, "runtime.json");
    await writeFile(
      manifest,
      JSON.stringify({ networkHash: `0x${"11".repeat(32)}` }),
    );
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", manifest);
    await expect(main()).rejects.toThrow(/disagree/);
    vi.stubEnv("GROUNDHOG_RUNTIME_MANIFEST", "");
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
