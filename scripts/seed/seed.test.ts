// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWalletClient,
  hashContract,
  toBase58,
  toHex0x,
  TransactionObservationError,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { ContractType, NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { StandardTokenFactory } from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory";
import { seed } from "./seed";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  requestAirdrop: vi.fn(),
  executeAndWait: vi.fn(),
}));
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async () => ({
    network: { networkHash: new Uint8Array(32).fill(1) },
  })),
  createWalletClient: vi.fn(() => mocks),
}));

let directory: string;
let env: Record<string, string>;
const evidence: SubmissionEvidence = {
  networkHash: new Uint8Array(32).fill(1),
  transactionHash: new Uint8Array(32).fill(2),
  signedTransaction: new Uint8Array([1, 2, 3]),
};

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "seed-test-"));
  const code = {
    contract_type: ContractType.kRv32,
    rv32_contract: { data: new Uint8Array([1, 2, 3]) },
  } as const;
  const hash = hashContract(code);
  env = {
    SEED_RECIPIENT: toBase58(new Uint8Array(32).fill(3)),
    LAUNCHPAD_APP_ENV: join(directory, "launchpad.env"),
    LAUNCHPAD_APP_PUBLIC_DIR: directory,
  };
  await mkdir(join(directory, "contract-artifacts"));
  await writeFile(
    join(directory, "contract-artifacts", `${toBase58(hash)}.json`),
    JSON.stringify({
      contractType: "rv32",
      hash: toBase58(hash),
      data: toHex0x(code.rv32_contract.data),
    }),
  );
  await writeFile(
    env.LAUNCHPAD_APP_ENV!,
    [
      "VITE_THRUPUT_RPC_URL=http://127.0.0.1:9545",
      `VITE_THRUPUT_NETWORK_ID=${toBase58(evidence.networkHash)}`,
      `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toBase58(new Uint8Array(32).fill(4))}`,
      `VITE_STANDARD_TOKEN_HASH=${toBase58(hash)}`,
    ].join("\n"),
  );
  vi.spyOn(StandardTokenFactory.v0_1.config, "view").mockResolvedValue({
    value: {
      token_code_hash: hash,
      native_token: NATIVE_TOKEN_ADDRESS,
      creation_fee: 0n,
      fee_recipient: null,
      required_token_funding: 1_000_000n,
    },
  } as never);
  vi.spyOn(StandardTokenFactory.v0_1.predictToken, "view").mockResolvedValue({
    value: new Uint8Array(32).fill(5),
  } as never);
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("logs the signed hash before an uncertain submission and stops without repeating it", async () => {
  const error = new TransactionObservationError(
    evidence,
    new Error("response lost"),
  );
  mocks.executeAndWait.mockImplementation(async () => {
    const options = vi.mocked(createWalletClient).mock.calls[0]![0];
    await options.onSigned!(evidence);
    expect(console.log).toHaveBeenCalledWith(
      `Submitting fund-gUSD: ${toBase58(evidence.transactionHash)}`,
    );
    throw error;
  });
  await expect(seed("tokens", env)).rejects.toBe(error);
  expect(mocks.executeAndWait).toHaveBeenCalledOnce();
  expect(mocks.requestAirdrop).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining("Completed"),
  );
});

it("stops before token writes when faucet funding is uncertain", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  mocks.requestAirdrop.mockRejectedValue(new Error("funding unresolved"));
  await expect(seed("tokens", env)).rejects.toThrow("funding unresolved");
  expect(mocks.requestAirdrop).toHaveBeenCalledOnce();
  expect(mocks.executeAndWait).not.toHaveBeenCalled();
});

it("rejects a different deployment network before creating a signer", async () => {
  await expect(
    seed("tokens", {
      ...env,
      VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
    }),
  ).rejects.toThrow(/network or RPC/);
  expect(createWalletClient).not.toHaveBeenCalled();
});

it("does not request more funding when a confirmed request has no visible balance increase", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  mocks.requestAirdrop.mockResolvedValue({
    transactionHash: evidence.transactionHash,
  });
  await expect(seed("tokens", env)).rejects.toThrow(/funding is not visible/);
  expect(mocks.requestAirdrop).toHaveBeenCalledOnce();
  expect(mocks.executeAndWait).not.toHaveBeenCalled();
});
