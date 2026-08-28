import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
import type { PublicDevelopmentPersona } from "@/development-personas";

const personas: PublicDevelopmentPersona[] = ["alice", "bob", "carol"].map(
  (id, index) => ({
    id: id as PublicDevelopmentPersona["id"],
    label: `${id[0]!.toUpperCase()}${id.slice(1)}`,
    accountAddress: contractAddress(new Uint8Array(32).fill(index + 1)),
    accountAddressHex: `0x${(index + 1).toString(16).padStart(64, "0")}`,
  }),
);

describe("DevelopmentWalletSwitcher", () => {
  it("shows the active account and switches personas", async () => {
    const switchTo = vi.fn();
    render(
      <DevelopmentWalletContext
        value={{
          active: personas[0]!,
          personas,
          switchTo,
          readPortfolio: async () => ({
            hogBalance: 10n,
            hogDecimals: 0,
            tokens: [],
            partial: false,
          }),
        }}
      >
        <DevelopmentWalletSwitcher />
      </DevelopmentWalletContext>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Alice/ }));
    expect(await screen.findByText("Development wallet")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(switchTo).toHaveBeenCalledWith("bob");
  });
});
