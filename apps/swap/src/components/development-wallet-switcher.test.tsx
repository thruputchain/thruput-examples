import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
import { parseDevelopmentPersonas } from "@/development-personas";

describe("DevelopmentWalletSwitcher", () => {
  it("shows the active persona and selects another wallet", async () => {
    const user = userEvent.setup();
    const personas = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    const switchTo = vi.fn(async () => {});
    render(
      <DevelopmentWalletContext value={{
        active: personas[0]!,
        personas,
        isSwitching: false,
        switchError: null,
        switchTo,
      }}>
        <DevelopmentWalletSwitcher />
      </DevelopmentWalletContext>,
    );

    await user.click(screen.getByRole("button", { name: "Development wallet: Alice" }));
    expect(screen.getByText("Initial liquidity provider")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Bob/ }));

    expect(switchTo).toHaveBeenCalledWith("bob");
  });
});

function persona(id: "alice" | "bob" | "carol", byte: number) {
  const hex = (value: number) => `0x${value.toString(16).padStart(2, "0").repeat(32)}`;
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    description: id === "alice" ? "Initial liquidity provider" : `${id} role`,
    accountAddress: hex(byte),
    privateKey: hex(byte + 10),
  };
}
