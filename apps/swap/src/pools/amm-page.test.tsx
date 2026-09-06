import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DevelopmentWalletContext } from "@/components/development-wallet-switcher";
import { AmmPage } from "@/pools/amm-page";

describe("AmmPage", () => {
  it("orders navigation actions and omits the trusted-driver notice", () => {
    const alice = {
      id: "alice" as const,
      label: "Alice",
      accountAddress: contractAddress(new Uint8Array(32).fill(1)),
      accountAddressHex: `0x${"01".repeat(32)}`,
    };
    render(
      <MemoryRouter>
        <DevelopmentWalletContext.Provider
          value={{
            active: alice,
            personas: [alice],
            isSwitching: false,
            switchError: null,
            readPortfolio: vi.fn(async () => ({
              tokens: [],
              liquidityPositions: [],
              invalidPoolCount: 0,
              unavailableAssetCount: 0,
              readAt: 1,
            })),
            switchTo: vi.fn(async () => {}),
          }}
        >
          <AmmPage
            title="Pools"
            description="Pool directory"
            actions={<button type="button">Refresh</button>}
          >
            <div>Pool content</div>
          </AmmPage>
        </DevelopmentWalletContext.Provider>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      Array.from(navigation.querySelectorAll("a, button")).map(
        (item) => item.getAttribute("aria-label") ?? item.textContent?.trim(),
      ),
    ).toEqual(["Pools", "Create Pool", "Refresh", "Development wallet: Alice"]);
    expect(
      screen.queryByText("Local trusted-driver limitation"),
    ).not.toBeInTheDocument();
  });

  it("hides creation and development wallet controls when read-only", () => {
    render(
      <MemoryRouter>
        <AmmPage title="Pools" description="Pool directory" readOnly>
          <div>Pool content</div>
        </AmmPage>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Create Pool" })).toBeNull();
    expect(screen.queryByText(/Development wallet/)).toBeNull();
  });
});
