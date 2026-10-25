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
import { toBase58 } from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import type { ContractDeployment } from "@thruputchain/client/wallet";
import { gasAmount, NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { loadServerConfig } from "../server/config";
import { Counter } from "../src/contracts/generated/counter";
import { provisionCounter } from "./provision";

const mocks = vi.hoisted(() => ({
  requestAirdrop: vi.fn(),
  executeAndWait: vi.fn(),
  deployContractAndWait: vi.fn(),
}));
vi.mock("@thruputchain/client", async (original) => {
  const sdk = await original<typeof import("@thruputchain/client")>();
  return {
    ...sdk,
    createThruputClient: vi.fn(async () => ({
      getVersionInfo: async () => ({ wireFormat: "14.0.0" }),
    })),
    createWalletClient: vi.fn(() => mocks),
  };
});

let directory: string;
let options: Parameters<typeof provisionCounter>[0];
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "counter-setup-"));
  options = {
    network: "local",
    rpcUrl: "http://127.0.0.1:9545",
    networkId: toBase58(new Uint8Array(32)),
    output: join(directory, ".env.local"),
    artifact: join(directory, "counter.rv32a"),
  };
  await writeFile(options.artifact!, "counter artifact");
  mocks.requestAirdrop.mockResolvedValue({ rawAmount: 1_000_000_000n });
  mocks.executeAndWait.mockResolvedValue({
    transactionHash: new Uint8Array(32),
  });
  mocks.deployContractAndWait.mockImplementation(
    async (deployment: ContractDeployment) => ({
      transactionHash: new Uint8Array(32),
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

it("creates a fresh counter and signer on each run and writes only an environment file", async () => {
  await provisionCounter(options);
  const first = loadServerConfig(
    parseEnv(await readFile(options.output, "utf8")),
  ).app;
  await provisionCounter(options);
  const second = loadServerConfig(
    parseEnv(await readFile(options.output, "utf8")),
  ).app;
  expect(second.counterAddress).not.toBe(first.counterAddress);
  expect(second.signerAddress).not.toBe(first.signerAddress);
  expect((await stat(options.output)).mode & 0o777).toBe(0o600);
  expect((await readdir(directory)).sort()).toEqual([
    ".env.local",
    "counter.rv32a",
  ]);
  expect(mocks.deployContractAndWait).toHaveBeenCalledTimes(2);
  expect(mocks.executeAndWait).toHaveBeenCalledTimes(4);
  const gas = gasAmount(10_000_000n);
  for (const [index, config] of [first, second].entries()) {
    const [deployment, deployOptions, wait] =
      mocks.deployContractAndWait.mock.calls[index]!;
    expect(toBase58(deployment.address)).toBe(config.counterAddress);
    expect(toBase58(deployment.deployer)).toBe(config.signerAddress);
    expect(deployOptions).toEqual({ gasLimit: gas, amount: 0n });
    expect(wait).toEqual({ timeoutMs: 60_000 });
    expect(mocks.executeAndWait.mock.calls[index * 2]).toEqual([
      {
        invocation: ERC20.v0_1.transfer.invocation(NATIVE_TOKEN_ADDRESS, gas, {
          receiver: deployment.address,
          amount: 10_000_000n,
        }),
        gasLimit: gas,
      },
      { timeoutMs: 60_000 },
    ]);
    expect(mocks.executeAndWait.mock.calls[index * 2 + 1]).toEqual([
      {
        invocation: Counter.v0_1.initialize.invocation(
          deployment.address,
          gas,
          {
            initialValue: 1_000_000n,
          },
        ),
        gasLimit: gas,
      },
      { timeoutMs: 60_000 },
    ]);
    expect(
      mocks.executeAndWait.mock.invocationCallOrder[index * 2],
    ).toBeLessThan(
      mocks.deployContractAndWait.mock.invocationCallOrder[index]!,
    );
    expect(
      mocks.deployContractAndWait.mock.invocationCallOrder[index],
    ).toBeLessThan(
      mocks.executeAndWait.mock.invocationCallOrder[index * 2 + 1]!,
    );
  }
});

it.each([
  "funding",
  "transaction",
  "deployment",
  "initialization",
  "verification",
])("preserves the existing environment when %s fails", async (phase) => {
  await writeFile(options.output, "previous environment");
  if (phase === "funding")
    mocks.requestAirdrop.mockRejectedValue(new Error("Funding stopped"));
  if (phase === "transaction")
    mocks.executeAndWait.mockRejectedValueOnce(
      new Error("Funding transaction failed"),
    );
  if (phase === "deployment")
    mocks.deployContractAndWait.mockRejectedValueOnce(
      new Error("Deployment address mismatch"),
    );
  if (phase === "initialization")
    mocks.executeAndWait
      .mockResolvedValueOnce({ transactionHash: new Uint8Array(32) })
      .mockRejectedValueOnce(new Error("Initialization failed"));
  if (phase === "verification")
    vi.mocked(Counter.v0_1.get.view).mockResolvedValue({ value: 0n } as never);
  await expect(provisionCounter(options)).rejects.toThrow();
  expect(
    (await readFile(options.output, "utf8")) === "previous environment",
  ).toBe(true);
  expect((await readdir(directory)).sort()).toEqual([
    ".env.local",
    "counter.rv32a",
  ]);
});
