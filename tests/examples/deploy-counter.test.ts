// Execute the actual example with failed later steps; earlier write evidence must survive.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  deploy: vi.fn(),
  execute: vi.fn(),
  view: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: async () => new Uint8Array([1]),
}));
vi.mock("../../examples/typescript/local-client.ts", () => ({
  createLocalClient: async () => ({}),
}));
vi.mock("@thruputchain/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@thruputchain/client")>()),
  createWalletClient: () => ({
    requestAirdrop: async () => ({
      txHash: new Uint8Array(32).fill(1),
      status: { result: "ok" },
    }),
    deployContractAndWait: calls.deploy,
    executeAndWait: calls.execute,
  }),
}));
vi.mock("../../examples/typescript/generated/counter.ts", () => ({
  Counter: {
    v0_1: {
      initialize: { invocation: vi.fn() },
      increment: { invocation: vi.fn() },
      ping: { invocation: vi.fn() },
      get: { view: calls.view },
    },
  },
}));

const hex = (byte: string) => `0x${byte.repeat(32)}`;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls.deploy.mockReset().mockResolvedValue({
    address: new Uint8Array(32).fill(5),
    txHash: new Uint8Array(32).fill(2),
  });
  calls.execute
    .mockReset()
    .mockResolvedValueOnce({
      txHash: new Uint8Array(32).fill(3),
      receipt: { height: 1n },
    })
    .mockResolvedValueOnce({ txHash: new Uint8Array(32).fill(4) });
  calls.view.mockReset().mockResolvedValue({ value: 47n });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("prints deployment evidence before a failed increment", async () => {
  calls.execute.mockReset().mockImplementation(async () => {
    expect(console.error).toHaveBeenCalledWith(
      `Deploy transaction: ${hex("02")}`,
    );
    throw new Error("increment failed");
  });
  await expect(
    import("../../examples/typescript/deploy-counter.ts"),
  ).rejects.toThrow("increment failed");
  expect(console.log).not.toHaveBeenCalled();
});

it("prints increment evidence before a failed readback", async () => {
  calls.view.mockImplementation(async () => {
    expect(console.error).toHaveBeenCalledWith(
      `Increment transaction: ${hex("03")}`,
    );
    throw new Error("view failed");
  });
  await expect(
    import("../../examples/typescript/deploy-counter.ts"),
  ).rejects.toThrow("view failed");
  expect(calls.execute).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it("keeps increment evidence when the value assertion fails", async () => {
  calls.view.mockResolvedValue({ value: 46n });
  await expect(
    import("../../examples/typescript/deploy-counter.ts"),
  ).rejects.toThrow("Counter should be 42 + 5");
  expect(console.error).toHaveBeenCalledWith(
    `Increment transaction: ${hex("03")}`,
  );
  expect(calls.execute).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it("keeps earlier hashes if ping fails", async () => {
  calls.execute
    .mockReset()
    .mockResolvedValueOnce({
      txHash: new Uint8Array(32).fill(3),
      receipt: { height: 1n },
    })
    .mockRejectedValueOnce(new Error("ping failed"));
  await expect(
    import("../../examples/typescript/deploy-counter.ts"),
  ).rejects.toThrow("ping failed");
  expect(console.error).toHaveBeenCalledWith(
    `Deploy transaction: ${hex("02")}`,
  );
  expect(console.error).toHaveBeenCalledWith(
    `Increment transaction: ${hex("03")}`,
  );
  expect(console.log).not.toHaveBeenCalled();
});

it("retains the final JSON result and logs each known hash on success", async () => {
  await import("../../examples/typescript/deploy-counter.ts");
  expect(
    vi.mocked(console.error).mock.calls.map(([message]) => message),
  ).toEqual([
    `Airdrop transaction: ${hex("01")}`,
    `Deploy transaction: ${hex("02")}`,
    `Increment transaction: ${hex("03")}`,
    `Ping transaction: ${hex("04")}`,
  ]);
  expect(console.log).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
    deployHash: hex("02"),
    incrementHash: hex("03"),
    eventHash: hex("04"),
    value: "47",
  });
});
