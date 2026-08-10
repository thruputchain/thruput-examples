import { contractAddress, sha256Hash } from "@groundhogchain/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import { createSwapPairReadAdapter } from "@/contracts/pair-adapter";
import { createReadClient, getValidatedChainTip } from "@/groundhog/client";

import { createSnapshotReader } from "./snapshot";

vi.mock("@/contracts/erc20-adapter", () => ({
  createErc20ReadAdapter: vi.fn(),
}));
vi.mock("@/contracts/pair-adapter", () => ({
  createSwapPairReadAdapter: vi.fn(),
}));
vi.mock("@/groundhog/client", () => ({
  createReadClient: vi.fn(),
  getValidatedChainTip: vi.fn(),
}));

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const hash = (byte: number) => sha256Hash(new Uint8Array(32).fill(byte));
const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: 9n,
  networkIdHex: "09".padStart(64, "0"),
  accountAddress: address(1),
  routerAddress: address(2),
  pairAddress: address(3),
  handlerAddress: address(4),
  driverAddress: address(5),
  tokenAAddress: address(6),
  tokenBAddress: address(7),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenDecimals: 6,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSnapshotReader", () => {
  it("accepts only an unchanged height/hash with every view at that height", async () => {
    const client = {};
    vi.mocked(createReadClient).mockReturnValue(client as never);
    vi.mocked(getValidatedChainTip)
      .mockResolvedValueOnce({ height: 6n, blockHash: hash(1) })
      .mockResolvedValueOnce({ height: 6n, blockHash: hash(2) })
      .mockResolvedValueOnce({ height: 7n, blockHash: hash(3) })
      .mockResolvedValueOnce({ height: 7n, blockHash: hash(3) })
      .mockResolvedValueOnce({ height: 8n, blockHash: hash(4) })
      .mockResolvedValueOnce({ height: 8n, blockHash: hash(4) });

    const tokenA = tokenAdapter("Token A", "A", 10n, 1n, 8n);
    const tokenB = tokenAdapter("Token B", "B", 20n, 2n, 8n);
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenA)
      .mockReturnValueOnce(tokenB);
    vi.mocked(createSwapPairReadAdapter).mockReturnValue({
      reserves: vi.fn().mockResolvedValue({
        value: { reserve0: 100n, reserve1: 200n, blockTimestamp: 5n },
        height: 8n,
      }),
      reservesFor: vi.fn(),
    });

    await expect(createSnapshotReader(config)()).resolves.toMatchObject({
      tokenA: { name: "Token A", balance: 10n, allowance: 1n },
      tokenB: { name: "Token B", balance: 20n, allowance: 2n },
      reserve0: 100n,
      reserve1: 200n,
      chainHeight: 8n,
    });
    expect(getValidatedChainTip).toHaveBeenCalledTimes(6);
    expect(getValidatedChainTip).toHaveBeenCalledWith(client, config.networkId);
  });

  it("fails after three attempts when view heights never match the tip", async () => {
    vi.mocked(createReadClient).mockReturnValue({} as never);
    vi.mocked(getValidatedChainTip).mockResolvedValue({
      height: 2n,
      blockHash: hash(1),
    });
    vi.mocked(createErc20ReadAdapter)
      .mockReturnValueOnce(tokenAdapter("A", "A", 1n, 0n, 1n))
      .mockReturnValueOnce(tokenAdapter("B", "B", 1n, 0n, 1n));
    vi.mocked(createSwapPairReadAdapter).mockReturnValue({
      reserves: vi.fn().mockResolvedValue({
        value: { reserve0: 1n, reserve1: 1n, blockTimestamp: 1n },
        height: 1n,
      }),
      reservesFor: vi.fn(),
    });

    await expect(createSnapshotReader(config)()).rejects.toThrow(
      "consistent chain snapshot after three attempts",
    );
  });
});

function tokenAdapter(
  name: string,
  symbol: string,
  balance: bigint,
  allowance: bigint,
  height: bigint,
) {
  return {
    metadata: vi.fn().mockResolvedValue({
      name: { value: name, height },
      symbol: { value: symbol, height },
      decimals: { value: 6, height },
    }),
    balanceOf: vi.fn().mockResolvedValue({ value: balance, height }),
    allowance: vi.fn().mockResolvedValue({ value: allowance, height }),
  };
}
