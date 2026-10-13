import type { TransactionReceipt } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import type { PoolSnapshot } from "@/swap/snapshot";
import { AllowanceCleanupCard } from "./allowance-cleanup-card";

vi.mock("@/thruput/client", async (original) => ({
  ...await original<object>(),
  createReadClient: vi.fn(async () => ({
    getNetworkInfo: async () => ({ networkHash: new Uint8Array(32) }),
  })),
}));

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  liquidityTokenAddress: address(11),
  handlerAddress: address(12),
  driverAddress: address(13),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;
const snapshot: PoolSnapshot = {
  tokenA: {
    address: config.tokenAAddress,
    name: "Token A",
    symbol: "A",
    decimals: 6,
    balance: 1_000n,
    allowance: 100n,
  },
  tokenB: {
    address: config.tokenBAddress,
    name: "Token B",
    symbol: "B",
    decimals: 6,
    balance: 1_000n,
    allowance: 0n,
  },
  reserve0: 1_000n,
  reserve1: 1_000n,
  reserveTimestamp: 1n,
  liquidityTotalSupply: 1_000n,
  liquidityBalance: 100n,
  liquidityAllowance: 0n,
  liquidityTokenSymbol: "LP",
  liquidityTokenDecimals: 6,
  feeTo: null,
  chainHeight: 1n,
  readAt: 1,
};

describe("AllowanceCleanupCard", () => {
  beforeEach(() => window.localStorage.clear());

  it("offers and confirms removal of unused allowance", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const execute = vi.fn(async (target, observer) => {
      expect(target.invoked_address).toEqual(config.tokenAAddress);
      observer?.onSigned(hex(40));
      return {
        kind: "committedSuccess" as const,
        hash: hex(40),
        receipt: {} as TransactionReceipt,
      };
    });
    render(
      <AllowanceCleanupCard
        config={config}
        snapshot={snapshot}
        readSnapshot={async () => snapshot}
        writer={{ execute }}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("heading", { name: "Unused allowances" })).toBeVisible();
    expect(screen.getByText("0.0001 unused")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reduce A allowance" }));

    expect(await screen.findByText("Unused allowance was removed.")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("stays hidden when no allowance exceeds unresolved exposure", () => {
    const { container } = render(
      <AllowanceCleanupCard
        config={config}
        snapshot={{
          ...snapshot,
          tokenA: { ...snapshot.tokenA, allowance: 0n },
        }}
        readSnapshot={async () => snapshot}
        writer={{ execute: vi.fn() }}
        onRefresh={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
