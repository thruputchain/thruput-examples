import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { contractAddress } from "@groundhogchain/protocol";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { PersonaConfiguredApp } from "@/app";
import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
import {
  parseDevelopmentPersonas,
  publicDevelopmentPersona,
} from "@/development-personas";
import type { GlobalConfig } from "@/config";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
  poolContractFunding: 100n,
} satisfies GlobalConfig;

describe("DevelopmentWalletSwitcher", () => {
  it("shows the active persona and selects another wallet", async () => {
    const user = userEvent.setup();
    const personas = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    const switchTo = vi.fn(async () => {});
    const publicPersonas = personas.map(publicDevelopmentPersona);
    render(
      <DevelopmentWalletContext value={{
        active: publicPersonas[0]!,
        personas: publicPersonas,
        isSwitching: false,
        switchError: null,
        switchTo,
      }}>
        <DevelopmentWalletSwitcher />
      </DevelopmentWalletContext>,
    );

    await user.click(screen.getByRole("button", { name: "Development wallet: Alice" }));
    expect(screen.getByText(`0x${"01".repeat(3)}...${"01".repeat(3)}`)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Bob/ }));

    expect(switchTo).toHaveBeenCalledWith("bob");
  });

  it("makes the old runtime inert until the locked switch remounts it", async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();
    const personas = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    let releaseLock: (() => void) | undefined;
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn((_name, _options, callback: (lock: Lock) => Promise<unknown>) =>
          new Promise((resolve) => {
            releaseLock = () => resolve(callback({ name: "wallet-switch", mode: "exclusive" }));
          })
        ),
      },
    });
    render(
      <MemoryRouter initialEntries={["/missing"]}>
        <PersonaConfiguredApp baseConfig={config} personas={personas} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Development wallet: Alice" }));
    await user.click(screen.getByRole("button", { name: /Bob/ }));

    expect(document.querySelector("[aria-busy='true']")).toHaveAttribute("inert");
    releaseLock?.();
    const trigger = await screen.findByRole("button", { name: "Development wallet: Bob" });
    expect(trigger).toHaveFocus();
    expect(window.sessionStorage.getItem(
      `groundhog-swap:active-persona:v1:${config.networkIdHex}:0x${"07".repeat(32)}`,
    )).toBe("bob");
  });
});

function persona(id: "alice" | "bob" | "carol", byte: number) {
  const hex = (value: number) => `0x${value.toString(16).padStart(2, "0").repeat(32)}`;
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    accountAddress: hex(byte),
    privateKey: hex(byte + 10),
  };
}
