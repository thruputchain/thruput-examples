import { contractAddress } from "@groundhogchain/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app";
import type { AppConfig } from "@/config";
import type { PoolSnapshot, SnapshotReader } from "@/swap/snapshot";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));

const config: AppConfig = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: 0n,
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  pairAddress: address(7),
  handlerAddress: address(6),
  driverAddress: address(5),
  tokenAAddress: address(1),
  tokenBAddress: address(2),
  tokenASymbol: "gUSD",
  tokenBSymbol: "gEUR",
  tokenDecimals: 6,
};

function pool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    tokenA: {
      address: config.tokenAAddress,
      name: "Groundhog USD",
      symbol: "gUSD",
      decimals: 6,
      balance: 12_000_000n,
      allowance: 0n,
    },
    tokenB: {
      address: config.tokenBAddress,
      name: "Groundhog EUR",
      symbol: "gEUR",
      decimals: 6,
      balance: 34_000_000n,
      allowance: 0n,
    },
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    reserveTimestamp: 1n,
    chainHeight: 7n,
    readAt: 1,
    ...overrides,
  };
}

function renderApp(readSnapshot: SnapshotReader = async () => pool()) {
  return render(<App config={config} readSnapshot={readSnapshot} />);
}

describe("read-only swap experience", () => {
  it("loads the local snapshot and derives an exact-input preview", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByLabelText("Loading pool")).toBeInTheDocument();
    await user.type(await screen.findByLabelText("YOU PAY"), "10");

    expect(screen.getByLabelText("Estimated output")).toHaveTextContent("19.74316");
    expect(screen.getByText("19.644444 gEUR")).toBeInTheDocument();
    expect(screen.getByText("Estimated output")).toBeInTheDocument();
    expect(screen.getByText("Minimum output")).toBeInTheDocument();
    expect(screen.getByText("0.3%", { selector: "dd" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Switch direction to gEUR for gUSD" }),
    );
    await user.type(screen.getByLabelText("YOU PAY"), "10");
    expect(screen.getByLabelText("Estimated output")).toHaveTextContent("4.960273");
    expect(screen.getByText("4.935471 gUSD")).toBeInTheDocument();
  });

  it("validates malformed, zero, precision, and excessive amounts", async () => {
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByLabelText("YOU PAY");

    await user.type(input, "nope");
    expect(screen.getByText("Enter a valid decimal amount.")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "0");
    expect(screen.getByText("Amount must be greater than zero.")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "0.0000001");
    expect(screen.getByText(/does not support that many/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "13");
    expect(screen.getByText(/exceeds your available balance/)).toBeInTheDocument();
  });

  it("uses the selected balance for Max and resets input on direction change", async () => {
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByLabelText("YOU PAY");

    await user.click(screen.getByRole("button", { name: "MAX" }));
    expect(input).toHaveValue("12");
    await user.click(
      screen.getByRole("button", { name: "Switch direction to gEUR for gUSD" }),
    );
    expect(input).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "MAX" }));
    expect(input).toHaveValue("34");
  });

  it("supports slippage presets, custom validation, and high-risk warning", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText("YOU PAY");

    await user.click(screen.getByRole("button", { name: /0.5%/ }));
    await user.click(screen.getByRole("radio", { name: "1%" }));
    expect(screen.getByLabelText("Custom percentage")).toHaveValue("1");
    await user.clear(screen.getByLabelText("Custom percentage"));
    await user.type(screen.getByLabelText("Custom percentage"), "5.01");
    expect(screen.getByText("High slippage")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Custom percentage"));
    await user.type(screen.getByLabelText("Custom percentage"), "50.01");
    expect(screen.getByText(/no more than 50%/)).toBeInTheDocument();
  });

  it("operates slippage and transaction details from the keyboard", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText("YOU PAY");

    const slippage = screen.getByRole("button", { name: /0.5%/ });
    slippage.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Slippage tolerance" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const details = screen.getByRole("button", {
      name: "Transaction details",
    });
    details.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Allowance change")).toBeInTheDocument();
  });

  it("distinguishes RPC failure, retry, and empty liquidity", async () => {
    const user = userEvent.setup();
    const read = vi
      .fn<SnapshotReader>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(pool({ reserve0: 0n }));
    renderApp(read);

    expect(await screen.findByText("RPC unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Empty pool")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pool has no liquidity/ })).toBeDisabled();
  });

  it("ignores an older refresh that resolves after a newer request", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: PoolSnapshot) => void) | undefined;
    const first = new Promise<PoolSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const read = vi
      .fn<SnapshotReader>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(pool({ chainHeight: 9n }));
    renderApp(read);

    await user.click(screen.getByRole("button", { name: "Refresh pool data" }));
    expect((await screen.findAllByText(/block 9/)).length).toBeGreaterThan(0);
    await act(async () => resolveFirst?.(pool({ chainHeight: 8n })));
    await waitFor(() =>
      expect(screen.getAllByText(/block 9/).length).toBeGreaterThan(0),
    );
  });

  it("does not label a configured remote endpoint as local", async () => {
    render(
      <App
        config={{ ...config, rpcUrl: new URL("https://rpc.example.com") }}
        readSnapshot={async () => pool()}
      />,
    );

    expect(await screen.findByText("Remote RPC")).toBeInTheDocument();
    expect(screen.getByText("Read-only preview")).toBeInTheDocument();
  });
});
