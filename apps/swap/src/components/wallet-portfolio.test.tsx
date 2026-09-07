import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WalletPortfolio } from "@/components/wallet-portfolio";
import { ExplorerProvider } from "@/components/explorer-context";

describe("WalletPortfolio", () => {
  it("links full fallback identity in token names, symbols and LP pool labels", async () => {
    const a = `0x${"01".repeat(32)}`;
    const b = `0x${"02".repeat(32)}`;
    const addresses = [1, 2].map((byte) => contractAddress(new Uint8Array(32).fill(byte)));
    const read = vi.fn().mockResolvedValue({
      tokens: [{ kind: "token", address: addresses[0], name: a, symbol: a, decimals: 6, balance: 1n }],
      liquidityPositions: [{ kind: "liquidity", address: addresses[0], symbol: "LP", decimals: 6, balance: 1n, poolSymbols: [a, b], poolTokens: addresses }],
      invalidPoolCount: 0, unavailableAssetCount: 0, readAt: 1,
    });
    render(<ExplorerProvider value="https://explorer.test"><WalletPortfolio read={read} /></ExplorerProvider>);
    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `https://explorer.test/address/${a}`, `https://explorer.test/address/${a}`,
      `https://explorer.test/address/${a}`, `https://explorer.test/address/${b}`,
    ]);
    expect(links.every((link) => link.textContent!.length < 20)).toBe(true);
  });
  it("retries a failed portfolio read", async () => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway disconnected"))
      .mockResolvedValueOnce({
        tokens: [],
        liquidityPositions: [],
        invalidPoolCount: 0,
        unavailableAssetCount: 0,
        readAt: 2,
      });
    render(<WalletPortfolio read={read} />);

    expect(await screen.findByText("Portfolio unavailable")).toBeVisible();
    expect(screen.getByText("gateway disconnected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry portfolio" }));

    expect(await screen.findByText("No holdings yet")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains holdings when a manual refresh fails", async () => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        tokens: [
          {
            kind: "token" as const,
            address: contractAddress(new Uint8Array(32).fill(1)),
            name: "Groundhog USD",
            symbol: "gUSD",
            decimals: 6,
            balance: 12_500_000n,
          },
          {
            kind: "token" as const,
            address: contractAddress(new Uint8Array(32).fill(2)),
            name: "HOG",
            symbol: "HOG",
            decimals: 7,
            balance: 199_893_783n,
          },
        ],
        liquidityPositions: [],
        invalidPoolCount: 0,
        unavailableAssetCount: 0,
        readAt: 1,
      })
      .mockRejectedValueOnce(new Error("timeout"));
    render(<WalletPortfolio read={read} />);

    expect(await screen.findByText("12.5")).toBeVisible();
    expect(screen.getByText("19.9893783")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Portfolio updated");
    await user.click(screen.getByRole("button", { name: "Refresh portfolio" }));

    expect(await screen.findByText("Portfolio refresh failed")).toBeVisible();
    expect(screen.getByText("12.5")).toBeVisible();
  });
});
