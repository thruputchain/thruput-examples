import { contractAddress } from "@groundhogchain/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { PersonaApp } from "@/app";
import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
import type { PublicDevelopmentPersona } from "@/development-personas";
import { parseDevelopmentPersonas } from "@/development-personas";
import { configuration } from "@/launch/workflow.test";

vi.mock("@/wallet/portfolio", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/wallet/portfolio")>();
  return {
    ...original,
    createWalletPortfolioReader: vi.fn(() => async () => ({
      hogBalance: 0n,
      hogDecimals: 0,
      tokens: [],
      partial: false,
    })),
  };
});

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
    const switchTo = vi.fn(async () => {});
    render(
      <DevelopmentWalletContext
        value={{
          active: personas[0]!,
          personas,
          isSwitching: false,
          switchError: null,
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

  it("makes the old runtime inert until the account lock permits switching", async () => {
    const user = userEvent.setup();
    const configured = parseDevelopmentPersonas(
      JSON.stringify([
        persona("alice", 1),
        persona("bob", 2),
        persona("carol", 3),
      ]),
    )!;
    let releaseLock!: () => void;
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const request = vi.fn((name: string, action: () => Promise<unknown>) => {
      if (name.includes(":write-session:")) return action();
      return new Promise((resolve) => {
        releaseLock = () => resolve(action());
      });
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    window.sessionStorage.clear();
    const view = render(
      <MemoryRouter initialEntries={["/missing"]}>
        <PersonaApp base={configuration()} personas={configured} />
      </MemoryRouter>,
    );
    try {
      await user.click(
        screen.getByRole("button", { name: "Development wallet: Alice" }),
      );
      await user.click(screen.getByRole("button", { name: /Bob/ }));
      expect(document.querySelector("[aria-busy='true']")).toHaveAttribute(
        "inert",
      );
      expect(request.mock.calls[0]?.[0]).toContain(":write-session:");
      expect(request.mock.calls[1]?.[0]).toContain(":write:");
      await act(async () => releaseLock());
      const trigger = await screen.findByRole("button", {
        name: "Development wallet: Bob",
      });
      expect(trigger).toHaveFocus();
    } finally {
      view.unmount();
      window.sessionStorage.clear();
      if (originalLocks) {
        Object.defineProperty(navigator, "locks", originalLocks);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
    }
  });
});

function persona(id: PublicDevelopmentPersona["id"], byte: number) {
  return {
    id,
    label: `${id[0]!.toUpperCase()}${id.slice(1)}`,
    accountAddress: `0x${byte.toString(16).padStart(64, "0")}`,
    privateKey: `0x${(byte + 3).toString(16).padStart(64, "0")}`,
  };
}
