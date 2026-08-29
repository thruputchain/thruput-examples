import { describe, expect, it, vi } from "vitest";

import { configuration } from "@/launch/workflow.test";
import { createWalletPortfolioReader } from "@/wallet/portfolio";

describe("wallet portfolio reader", () => {
  it("shows global positive holdings and reports incomplete discovery", async () => {
    const config = configuration();
    const readTokens = vi.fn().mockResolvedValue({
      tokens: [token("HELD", 5n), token("EMPTY", 0n), token("UNKNOWN", null)],
      truncated: true,
      historyLimited: false,
    });
    const client = {
      view: vi.fn().mockRejectedValue(new Error("native unavailable")),
    };
    const read = createWalletPortfolioReader(
      client as never,
      config,
      readTokens,
    );

    const result = await read();

    expect(readTokens).toHaveBeenCalledWith(client, config, { creator: null });
    expect(result.tokens).toEqual([
      expect.objectContaining({ symbol: "HELD", balance: 5n }),
    ]);
    expect(result.partial).toBe(true);
  });
});

function token(symbol: string, balance: bigint | null) {
  return {
    addressHex: `0x${symbol.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    name: symbol,
    symbol,
    decimals: 0,
    initialSupply: 5n,
    balance,
    administratorHex: `0x${"01".repeat(32)}`,
    holderHex: `0x${"01".repeat(32)}`,
    block: 1n,
    transactionHash: `0x${"02".repeat(32)}`,
    readError: balance === null,
  };
}
