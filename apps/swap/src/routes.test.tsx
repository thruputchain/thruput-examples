import { contractAddress } from "@thruputchain/protocol";
import { toBase58 } from "@thruputchain/client";
import { render, screen } from "@/test/render";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PoolRoutes } from "@/routes";
import { loadRuntimeConfig } from "@/config";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { GlobalConfig } from "@/config";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

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
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(1),
  routerAddress: address(2),
  factoryAddress: address(3),
  nativeTokenAddress: address(4),
};

describe("PoolRoutes", () => {
  it("redirects the root route to the pool directory", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProcessingModeProvider>
          <PoolRoutes config={config} />
        </ProcessingModeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Pools" })).toBeVisible();
  });

  it("renders the create-pool route", () => {
    render(
      <MemoryRouter initialEntries={["/pools/new"]}>
        <ProcessingModeProvider>
          <PoolRoutes config={config} />
        </ProcessingModeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Create pool" })).toBeVisible();
  });

  it.each(["", `?tokenA=0x${"05".repeat(32)}&tokenB=0x${"06".repeat(32)}`])(
    "retains pool creation and presets %s while waiting for a wallet connection",
    async (search) => {
      render(
        <MemoryRouter initialEntries={[`/pools/new${search}`]}>
          <ProcessingModeProvider>
            <PoolRoutes config={config} readOnly />
            <LocationPath />
          </ProcessingModeProvider>
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole("heading", { name: "Connect your wallet" }),
      ).toBeVisible();
      expect(screen.getByTestId("location-path")).toHaveTextContent(
        `/pools/new${search}`,
      );
      expect(
        screen.queryByRole("heading", { name: "Create pool" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["swap", "liquidity"])(
    "redirects the %s route to pool detail when read-only",
    async (view) => {
      const token0 = toBase58(new Uint8Array(32).fill(0x05));
      const token1 = toBase58(new Uint8Array(32).fill(0x06));
      render(
        <MemoryRouter initialEntries={[`/pools/${token0}/${token1}/${view}`]}>
          <ProcessingModeProvider>
            <PoolRoutes config={config} readOnly />
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
  const location = useLocation();
  return (
    <output data-testid="location-path">
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("browser configuration", () => {
  afterEach(() => vi.restoreAllMocks());
  it("loads runtime settings and always uses the same-origin RPC endpoint", async () => {
    const body = {
      VITE_EXPLORER_URL: "https://Explorer.test/",
      VITE_THRUPUT_RPC_URL: "https://ignored-upstream.test",
      VITE_THRUPUT_NETWORK_ID: b58(0x00),
      VITE_NATIVE_TOKEN_ADDRESS: b58(0x02),
      VITE_SWAP_FACTORY_ADDRESS: b58(0x03),
      VITE_SWAP_ROUTER_ADDRESS: b58(0x04),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body)));
    const config = await loadRuntimeConfig();
    expect(config.rpcUrl.href).toBe("http://localhost/thruput-rpc");
    expect(config.explorerUrl).toBe("https://explorer.test");
    body.VITE_EXPLORER_URL = "https://explorer.test/path";
    await expect(loadRuntimeConfig()).rejects.toThrow("VITE_EXPLORER_URL");
  });
});
