import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WalletPortfolio } from "@/components/wallet-portfolio";

describe("WalletPortfolio", () => {
  it("shows native and factory-created token balances", async () => {
    render(
      <WalletPortfolio
        read={async () => ({
          hogBalance: 123_400n,
          hogDecimals: 2,
          tokens: [
            {
              addressHex: `0x${"01".repeat(32)}`,
              symbol: "NUT",
              decimals: 2,
              balance: 123n,
            },
          ],
          partial: false,
        })}
      />,
    );
    expect(await screen.findByText("1234")).toBeInTheDocument();
    expect(screen.getByText("NUT")).toBeInTheDocument();
    expect(screen.getByText("1.23")).toBeInTheDocument();
  });

  it("reports partial reads and refreshes on request", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        hogBalance: null,
        hogDecimals: null,
        tokens: [],
        partial: true,
      })
      .mockResolvedValueOnce({
        hogBalance: 5n,
        hogDecimals: 0,
        tokens: [],
        partial: false,
      });
    render(<WalletPortfolio read={read} />);
    expect(
      await screen.findByText("Some balances could not be refreshed."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh balances" }),
    );
    expect(await screen.findByText("5")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("offers a retry after a complete reader failure", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        hogBalance: 7n,
        hogDecimals: 0,
        tokens: [],
        partial: false,
      });
    render(<WalletPortfolio read={read} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Portfolio unavailable",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("7")).toBeInTheDocument();
  });
});
