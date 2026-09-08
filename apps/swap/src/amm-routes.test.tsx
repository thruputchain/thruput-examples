import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AmmRoutes, readBrowserConfiguration } from "@/app";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { GlobalConfig } from "@/config";

vi.mock("@/pools/pool-directory-page", () => ({
  PoolDirectoryPage: () => <h1>Pools</h1>,
}));
vi.mock("@/pools/pool-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/pools/pool-context")>()),
  resolvePoolConfig: vi.fn(() => new Promise(() => {})),
}));

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const config: GlobalConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeHogAddress: address(4),
};

describe("AmmRoutes", () => {
  it("redirects the root route to the pool directory", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProcessingModeProvider>
          <AmmRoutes config={config} />
        </ProcessingModeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Pools" })).toBeVisible();
  });

  it("renders the create-pool route", () => {
    render(
      <MemoryRouter initialEntries={["/pools/new"]}>
        <ProcessingModeProvider>
          <AmmRoutes config={config} />
        </ProcessingModeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Create pool" })).toBeVisible();
  });

  it.each(["", `?tokenA=0x${"05".repeat(32)}&tokenB=0x${"06".repeat(32)}`])("redirects pool creation with presets %s to the directory when read-only", async (search) => {
    render(
      <MemoryRouter initialEntries={[`/pools/new${search}`]}>
        <ProcessingModeProvider>
          <AmmRoutes config={config} readOnly />
        </ProcessingModeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Pools" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Create pool" }),
    ).not.toBeInTheDocument();
  });

  it.each(["swap", "liquidity"])(
    "redirects the %s route to pool detail when read-only",
    async (view) => {
      const token0 = `0x${"05".repeat(32)}`;
      const token1 = `0x${"06".repeat(32)}`;
      render(
        <MemoryRouter initialEntries={[`/pools/${token0}/${token1}/${view}`]}>
          <ProcessingModeProvider>
            <AmmRoutes config={config} readOnly />
            <LocationPath />
          </ProcessingModeProvider>
        </MemoryRouter>,
      );

      expect(await screen.findByTestId("location-path")).toHaveTextContent(
        `/pools/${token0}/${token1}`,
      );
    },
  );
});

function LocationPath() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

describe("browser configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards registry and discovery settings through browser bootstrap", () => {
    vi.stubEnv("VITE_EXPLORER_URL", "https://Explorer.test/");
    vi.stubEnv("VITE_GROUNDHOG_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("VITE_GROUNDHOG_NETWORK_ID", "00".repeat(32));
    vi.stubEnv("VITE_POOL_TOKEN_HASH", `0x${"01".repeat(32)}`);
    vi.stubEnv("VITE_NATIVE_HOG_ADDRESS", `0x${"02".repeat(32)}`);
    vi.stubEnv("VITE_SWAP_FACTORY_ADDRESS", `0x${"03".repeat(32)}`);
    vi.stubEnv("VITE_SWAP_ROUTER_ADDRESS", `0x${"04".repeat(32)}`);
    vi.stubEnv("VITE_POOL_REGISTRY_ENABLED", "true");
    vi.stubEnv("VITE_TOKEN_DISCOVERY_ENABLED", "true");
    vi.stubEnv("VITE_STANDARD_TOKEN_FACTORY_ADDRESS", `0x${"AB".repeat(32)}`);
    vi.stubEnv("VITE_STANDARD_TOKEN_HASH", "CD".repeat(32));

    expect(readBrowserConfiguration()).toMatchObject({
      ok: true,
      config: {
        explorerUrl: "https://explorer.test",
        registryEnabled: true,
        poolTokenHash: `0x${"01".repeat(32)}`,
        tokenDiscovery: {
          enabled: true,
          scope: {
            networkId: "00".repeat(32),
            factoryAddress: `0x${"ab".repeat(32)}`,
            tokenCodeHash: `0x${"cd".repeat(32)}`,
          },
        },
      },
    });
    vi.stubEnv("VITE_STANDARD_TOKEN_HASH", "invalid");
    expect(readBrowserConfiguration().ok).toBe(false);
    vi.stubEnv("VITE_STANDARD_TOKEN_HASH", "CD".repeat(32));
    vi.stubEnv("VITE_EXPLORER_URL", "https://explorer.test/path");
    expect(readBrowserConfiguration()).toMatchObject({ ok: false, message: expect.stringContaining("VITE_EXPLORER_URL") });
  });
});
