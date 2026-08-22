import { contractAddress } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSwapFactoryReadAdapter } from "./factory-adapter";

const methods = vi.hoisted(() => ({
  allPairsLength: { view: vi.fn() },
  pairAt: { view: vi.fn() },
  getPair: { view: vi.fn() },
  poolAddresses: { view: vi.fn() },
  feeTo: { view: vi.fn() },
}));

vi.mock("@/contracts/generated/swap-factory", () => ({
  SwapFactory: methods,
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));

beforeEach(() => vi.clearAllMocks());

describe("createSwapFactoryReadAdapter", () => {
  it("forwards typed view arguments and normalizes pool fields", async () => {
    const result = (value: unknown) => ({ value, height: 4n, events: [] });
    methods.allPairsLength.view.mockResolvedValue(result(1n));
    methods.pairAt.view.mockResolvedValue(result([address(1), address(2)]));
    methods.getPair.view.mockResolvedValue(result(address(3)));
    methods.poolAddresses.view.mockResolvedValue(result({
      pair: address(3),
      liquidity_token: address(4),
      handler: address(5),
      driver: address(6),
    }));
    methods.feeTo.view.mockResolvedValue(result(null));
    const client = { view: vi.fn() };
    const adapter = createSwapFactoryReadAdapter({
      client,
      contract: address(7),
      caller: address(8),
    });

    await expect(adapter.allPairsLength()).resolves.toMatchObject({ value: 1n });
    await expect(adapter.pairAt(0n)).resolves.toMatchObject({
      value: [address(1), address(2)],
    });
    await expect(adapter.getPair(address(1), address(2))).resolves.toMatchObject({
      value: address(3),
    });
    await expect(adapter.poolAddresses(address(1), address(2))).resolves.toMatchObject({
      value: {
        pair: address(3),
        liquidityToken: address(4),
        handler: address(5),
        driver: address(6),
      },
    });
    await expect(adapter.feeTo()).resolves.toMatchObject({ value: null });

    expect(methods.pairAt.view).toHaveBeenCalledWith(
      expect.objectContaining({ args: { index: 0n } }),
    );
    expect(methods.getPair.view).toHaveBeenCalledWith(
      expect.objectContaining({ args: { tokenA: address(1), tokenB: address(2) } }),
    );
  });
});
