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
import { DefaultWallet } from "@groundhogchain/client/contracts";
import { ExecResult } from "@groundhogchain/protocol";
import { loadServerConfig } from "../server/config";
import { Counter } from "../src/contracts/generated/counter";
import { provisionCounter } from "./provision";

const mocks = vi.hoisted(() => ({
  address: new Uint8Array(32),
  requestAirdrop: vi.fn(),
  execute: vi.fn(),
  sendInvocation: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
vi.mock("@groundhogchain/client", async (original) => {
  const sdk = await original<typeof import("@groundhogchain/client")>();
  return {
    ...sdk,
    createGroundhogClient: vi.fn(async () => ({
      getVersion: async () => ({ wireFormat: "5.0.0" }),
    })),
    createWalletClient: vi.fn(() => mocks),
    deriveContractAddress: (
      ...args: Parameters<typeof sdk.deriveContractAddress>
    ) => {
      const address = sdk.deriveContractAddress(...args);
      mocks.address = new Uint8Array(address);
      return address;
    },
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
    networkId: `0x${"00".repeat(32)}`,
    output: join(directory, ".env.local"),
    artifact: join(directory, "counter.rv32a"),
  };
  await writeFile(options.artifact!, "counter artifact");
  mocks.requestAirdrop.mockResolvedValue({ status: { result: "ok" } });
  mocks.execute.mockResolvedValue(new Uint8Array(32));
  mocks.sendInvocation.mockResolvedValue(new Uint8Array(32));
  mocks.waitForTransactionReceipt.mockResolvedValue({
    execResult: ExecResult.ExecResultOK,
  });
  vi.spyOn(DefaultWallet.deploy, "decodeReceipt").mockImplementation(
    () => ({ value: mocks.address }) as never,
  );
  vi.spyOn(Counter.get, "view").mockResolvedValue({
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
  expect(mocks.sendInvocation).toHaveBeenCalledTimes(2);
  expect(mocks.execute).toHaveBeenCalledTimes(4);
});

it.each(["funding", "transaction", "verification"])(
  "preserves the existing environment when %s fails",
  async (phase) => {
    await writeFile(options.output, "previous environment");
    if (phase === "funding")
      mocks.requestAirdrop.mockResolvedValue({
        status: { result: "reverted" },
      });
    if (phase === "transaction")
      mocks.waitForTransactionReceipt.mockResolvedValue({
        execResult: ExecResult.ExecResultTxDeterministicError,
      });
    if (phase === "verification")
      vi.mocked(Counter.get.view).mockResolvedValue({ value: 0n } as never);
    await expect(provisionCounter(options)).rejects.toThrow();
    expect(
      (await readFile(options.output, "utf8")) === "previous environment",
    ).toBe(true);
    expect((await readdir(directory)).sort()).toEqual([
      ".env.local",
      "counter.rv32a",
    ]);
  },
);
