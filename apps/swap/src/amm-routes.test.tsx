import { contractAddress } from "@groundhogchain/protocol";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AmmRoutes } from "@/app";
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
  poolContractFunding: 10_000_000n,
};

describe("AmmRoutes", () => {
  it("redirects the root route to the pool directory", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AmmRoutes config={config} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Pools" })).toBeVisible();
  });

  it("renders the create-pool route", () => {
    render(
      <MemoryRouter initialEntries={["/pools/new"]}>
        <AmmRoutes config={config} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Create pool" })).toBeVisible();
  });
});
