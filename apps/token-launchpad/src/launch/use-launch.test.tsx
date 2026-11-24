// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import type { FormEvent } from "react";
import { expect, it, vi } from "vitest";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { ERC20 } from "@/contracts/generated/standard-token";
import { configuration } from "@/test/fixtures";
import { useLaunch } from "./use-launch";

const predicted = contractAddress(new Uint8Array(32).fill(9));
const mocks = vi.hoisted(() => ({ send: vi.fn(), fundingAmount: 500n }));
vi.mock("@thruputchain/react", () => ({ useClient: () => ({}) }));
vi.mock("@/contracts/launchpad-client", () => ({
  reviewFactory: async () => ({
    predictedAddress: predicted,
    fundingAmount: mocks.fundingAmount,
    fundingShortfall: 0n,
  }),
}));
vi.mock("@/contracts/token-artifact", () => ({
  loadStandardTokenArtifact: async () => ({ code: "token" }),
}));
vi.mock("@/transactions/use-wallet-transaction", () => ({
  useWalletTransaction: () => ({
    send: mocks.send,
    blocked: false,
    completed: null,
    message: null,
    reset: () => {},
  }),
}));

async function reviewAndLaunch() {
  const { result } = renderHook(() => useLaunch(configuration()));
  act(() => {
    result.current.edit("name", "Acorn");
    result.current.edit("symbol", "ACRN");
  });
  await act(() =>
    result.current.reviewLaunch({ preventDefault() {} } as FormEvent),
  );
  await act(() => result.current.launch());
  const [label, build, context] = mocks.send.mock.lastCall!;
  // `send` builds the request after it takes its lock.
  return [label, await build(), context];
}

it("funds the predicted address and creates the token in one batch", async () => {
  const [label, request, context] = await reviewAndLaunch();
  expect(label).toBe("Launch token");
  expect(request.calls.map((call: { method: { name: string } }) => call.method.name)).toEqual([
    ERC20.v0_1.transfer.name,
    StandardTokenFactory.v0_1.createToken.name,
  ]);
  expect(request.contractsToDeploy).toEqual([{ code: "token" }]);
  expect(context).toEqual({
    address: toBase58(predicted),
    name: "Acorn",
    symbol: "ACRN",
  });
});

it("skips the funding call when the address is already funded", async () => {
  mocks.fundingAmount = 0n;
  const [, request] = await reviewAndLaunch();
  expect(request.calls).toHaveLength(1);
});
