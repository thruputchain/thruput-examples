import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AmmRoutes, readBrowserConfiguration } from "@/app";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { GlobalConfig } from "@/config";

vi.mock("@/pools/pool-directory-page", () => ({
  PoolDirectoryPage: () => <h1>Pools</h1>,
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
});

describe("browser configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards the pool registry feature flag", () => {
    vi.stubEnv("VITE_GROUNDHOG_RPC_URL", "http://127.0.0.1:9545");
    vi.stubEnv("VITE_GROUNDHOG_NETWORK_ID", "00".repeat(32));
    vi.stubEnv("VITE_GROUNDHOG_WALLET_ADDRESS", `0x${"01".repeat(32)}`);
    vi.stubEnv("VITE_NATIVE_HOG_ADDRESS", `0x${"02".repeat(32)}`);
    vi.stubEnv("VITE_SWAP_FACTORY_ADDRESS", `0x${"03".repeat(32)}`);
    vi.stubEnv("VITE_SWAP_ROUTER_ADDRESS", `0x${"04".repeat(32)}`);
    vi.stubEnv("VITE_POOL_REGISTRY_ENABLED", "true");

    expect(readBrowserConfiguration()).toMatchObject({
      ok: true,
      config: { registryEnabled: true },
    });
  });
});
