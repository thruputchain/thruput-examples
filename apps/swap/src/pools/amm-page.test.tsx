import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AmmPage } from "@/pools/amm-page";

describe("AmmPage", () => {
  it("orders navigation actions and omits the trusted-driver notice", () => {
    render(
      <MemoryRouter>
          <AmmPage
            title="Pools"
            description="Pool directory"
            actions={<button type="button">Refresh</button>}
          >
            <div>Pool content</div>
          </AmmPage>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      Array.from(navigation.querySelectorAll("a, button")).map(
        (item) => item.getAttribute("aria-label") ?? item.textContent?.trim(),
      ),
    ).toEqual(["Pools", "Create Pool"]);
    expect(
      Array.from(screen.getByRole("banner").querySelectorAll("button"))
        .map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim()),
    ).toEqual(["Open navigation", "Refresh"]);
    expect(
      screen.queryByText("Local trusted-driver limitation"),
    ).not.toBeInTheDocument();
  });

  it("hides creation when disconnected", () => {
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
