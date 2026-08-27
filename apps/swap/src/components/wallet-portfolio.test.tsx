import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WalletPortfolio } from "@/components/wallet-portfolio";

describe("WalletPortfolio", () => {
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
        ],
        liquidityPositions: [],
        invalidPoolCount: 0,
        unavailableAssetCount: 0,
        readAt: 1,
      })
      .mockRejectedValueOnce(new Error("timeout"));
    render(<WalletPortfolio read={read} />);

    expect(await screen.findByText("12.5")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Portfolio updated");
    await user.click(screen.getByRole("button", { name: "Refresh portfolio" }));

    expect(await screen.findByText("Portfolio refresh failed")).toBeVisible();
    expect(screen.getByText("12.5")).toBeVisible();
  });
});
