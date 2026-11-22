// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hashContract,
  toBase58,
  ThruputError,
  toHex0x,
  type SubmissionEvidence,
} from "@thruputchain/client";
import { ContractType, NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { withScenario } from "@thruputchain/testkit";
import { StandardTokenFactory } from "../../apps/token-launchpad/src/contracts/generated/standard-token-factory";
import { seed } from "./seed";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  fund: vi.fn(),
  call: vi.fn(),
  view: vi.fn(),
}));
vi.mock("@thruputchain/client", async (original) => ({
  ...(await original<typeof import("@thruputchain/client")>()),
  createThruputClient: vi.fn(async () => ({
    network: { networkHash: new Uint8Array(32).fill(1) },
  })),
}));
// Unit tests check the seed's stop conditions. Testkit's own tests cover
// transaction recording, and tests/e2e/seed.ts runs the real flow on a node.
vi.mock("@thruputchain/testkit", async (original) => ({
  ...(await original<typeof import("@thruputchain/testkit")>()),
  withScenario: vi.fn(async (options, run) => {
    const actor = {
      wallet: { getBalance: mocks.getBalance },
      fund: mocks.fund,
      call: mocks.call,
    };
    return run({ actor: () => actor, view: mocks.view });
  }),
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
  mocks.view.mockResolvedValue({ value: new Uint8Array(32).fill(5) });
  mocks.getBalance.mockResolvedValue({ rawBalance: 1_000_000_000n });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("logs the signed hash before an uncertain submission and stops without repeating it", async () => {
  const error = new ThruputError("transactionOutcomeUnknown", "response lost", {
    transaction: {
      hash: evidence.transactionHash,
      outcome: "unknown",
      reason: "disconnected",
    },
    cause: new Error("response lost"),
  });
  mocks.call.mockImplementation(async () => {
    const options = vi.mocked(withScenario).mock.calls[0]![0];
    await options.onSigned!("seed", evidence);
    expect(console.log).toHaveBeenCalledWith(
      `Submitting fund-gUSD: ${toBase58(evidence.transactionHash)}`,
    );
    throw error;
  });
  await expect(seed("tokens", env)).rejects.toBe(error);
  expect(mocks.call).toHaveBeenCalledOnce();
  expect(mocks.fund).not.toHaveBeenCalled();
  // No run directory: the seed saves no key or journal.
  const options = vi.mocked(withScenario).mock.calls[0]![0];
  expect(options.runDirectory).toBeUndefined();
  // The scenario is pinned to the app's network, with the one seed actor.
  expect(options.network.cluster.networkHash).toEqual(evidence.networkHash);
  expect(Object.keys(options.accounts)).toEqual(["seed"]);
  // The stopped transaction's hash is printed for inspection.
  expect(console.error).toHaveBeenCalledWith(
    `Inspect transaction ${toBase58(evidence.transactionHash)} before continuing.`,
  );
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining("Completed"),
  );
});

it("stops before token writes when faucet funding is uncertain", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  mocks.fund.mockRejectedValue(new Error("funding unresolved"));
  await expect(seed("tokens", env)).rejects.toThrow("funding unresolved");
  expect(mocks.fund).toHaveBeenCalledOnce();
  expect(mocks.call).not.toHaveBeenCalled();
});

it("rejects a different deployment network before creating a signer", async () => {
  await expect(
    seed("tokens", {
      ...env,
      VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32)),
    }),
  ).rejects.toThrow(/network or RPC/);
  expect(withScenario).not.toHaveBeenCalled();
});

it("does not request more funding when a confirmed request has no visible balance increase", async () => {
  mocks.getBalance.mockResolvedValue({ rawBalance: 0n });
  mocks.fund.mockResolvedValue({
    transactionHash: evidence.transactionHash,
  });
  await expect(seed("tokens", env)).rejects.toThrow(/funding is not visible/);
  expect(mocks.fund).toHaveBeenCalledOnce();
  expect(mocks.call).not.toHaveBeenCalled();
});
