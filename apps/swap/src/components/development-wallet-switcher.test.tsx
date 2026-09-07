import { act, render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { contractAddress } from "@groundhogchain/protocol";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PersonaConfiguredApp } from "@/app";
import { ExplorerProvider } from "@/components/explorer-context";
import {
  DevelopmentWalletContext,
  DevelopmentWalletSwitcher,
} from "@/components/development-wallet-switcher";
import {
  parseDevelopmentPersonas,
  publicDevelopmentPersona,
} from "@/development-personas";
import type { GlobalConfig } from "@/config";
import {
  createWalletPortfolioReader,
  type WalletPortfolio,
} from "@/wallet/portfolio";

vi.mock("@/wallet/portfolio", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/wallet/portfolio")>();
  return {
    ...original,
    createWalletPortfolioReader: vi.fn(() => vi.fn().mockResolvedValue(emptyPortfolio)),
  };
});

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
} satisfies GlobalConfig;

beforeEach(() => {
  vi.mocked(createWalletPortfolioReader).mockImplementation(
    () => vi.fn().mockResolvedValue(emptyPortfolio),
  );
});

describe("DevelopmentWalletSwitcher", () => {
  it("shows the active persona and selects another wallet", async () => {
    const user = userEvent.setup();
    const personas = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    const switchTo = vi.fn(async () => {});
    const readPortfolio = vi.fn().mockResolvedValue({
      tokens: [{
        kind: "token" as const,
        address: address(4),
        name: "Groundhog USD",
        symbol: "gUSD",
        decimals: 6,
        balance: 12_500_000n,
      }],
      liquidityPositions: [{
        kind: "liquidity" as const,
        address: address(5),
        symbol: "LP",
        decimals: 0,
        balance: 42n,
        poolSymbols: ["gUSD", "gEUR"] as const,
        poolTokens: [address(4), address(6)] as const,
      }],
      invalidPoolCount: 0,
      unavailableAssetCount: 0,
      readAt: 1,
    });
    const publicPersonas = personas.map(publicDevelopmentPersona);
    render(
      <ExplorerProvider value="https://explorer.test">
      <DevelopmentWalletContext value={{
        active: publicPersonas[0]!,
        personas: publicPersonas,
        isSwitching: false,
        switchError: null,
        readPortfolio,
        switchTo,
      }}>
        <DevelopmentWalletSwitcher />
      </DevelopmentWalletContext>
      </ExplorerProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Development wallet: Alice" }));
    const accountLink = screen.getByRole("link", { name: `Alice account address: 0x${"01".repeat(32)} (opens explorer in a new tab)` });
    expect(accountLink).toHaveAttribute("href", `https://explorer.test/address/0x${"01".repeat(32)}`);
    expect(accountLink.closest("button")).toBeNull();
    expect(switchTo).not.toHaveBeenCalled();
    expect(await screen.findByText("12.5")).toBeVisible();
    expect(screen.getByText("gUSD / gEUR")).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Bob" }));

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
    await user.click(screen.getByRole("button", { name: "Bob" }));

    expect(document.querySelector("[aria-busy='true']")).toHaveAttribute("inert");
    releaseLock?.();
    const trigger = await screen.findByRole("button", { name: "Development wallet: Bob" });
    expect(trigger).toHaveFocus();
    expect(window.sessionStorage.getItem(
      `groundhog-swap:active-persona:v1:${config.networkIdHex}:0x${"07".repeat(32)}`,
    )).toBe("bob");
  });

  it("discards a late portfolio read after switching wallets", async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();
    const personas = parseDevelopmentPersonas(JSON.stringify([
      persona("alice", 1),
      persona("bob", 2),
      persona("carol", 3),
    ]))!;
    let resolveAlice: ((portfolio: WalletPortfolio) => void) | undefined;
    const aliceRead = new Promise<WalletPortfolio>((resolve) => {
      resolveAlice = resolve;
    });
    vi.mocked(createWalletPortfolioReader).mockImplementation((activeConfig) =>
      activeConfig.accountAddress[0] === 1
        ? () => aliceRead
        : async () => portfolio("BOB", 2)
    );
    render(
      <MemoryRouter initialEntries={["/missing"]}>
        <PersonaConfiguredApp baseConfig={config} personas={personas} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Development wallet: Alice" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading portfolio");
    await user.click(screen.getByRole("button", { name: "Bob" }));
    await screen.findByRole("button", { name: "Development wallet: Bob" });
    await act(async () => resolveAlice?.(portfolio("ALICE", 1)));
    await user.click(screen.getByRole("button", { name: "Development wallet: Bob" }));

    expect(await screen.findByText("BOB")).toBeVisible();
    expect(screen.queryByText("ALICE")).not.toBeInTheDocument();
  });
});

const emptyPortfolio = {
  tokens: [],
  liquidityPositions: [],
  invalidPoolCount: 0,
  unavailableAssetCount: 0,
  readAt: 1,
};

function portfolio(symbol: string, byte: number): WalletPortfolio {
  return {
    tokens: [{
      kind: "token",
      address: address(byte),
      name: `${symbol} token`,
      symbol,
      decimals: 0,
      balance: 1n,
    }],
    liquidityPositions: [],
    invalidPoolCount: 0,
    unavailableAssetCount: 0,
    readAt: 1,
  };
}

function persona(id: "alice" | "bob" | "carol", byte: number) {
  const hex = (value: number) => `0x${value.toString(16).padStart(2, "0").repeat(32)}`;
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    accountAddress: hex(byte),
    privateKey: hex(byte + 10),
  };
}
