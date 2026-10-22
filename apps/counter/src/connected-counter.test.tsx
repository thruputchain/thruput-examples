// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectedCounter } from "./app";
import { initialSnapshot } from "./transactions/engine";
import type { AppConfig } from "./config";

const { send, worker, read } = vi.hoisted(() => ({
  send: vi.fn(),
  worker: vi.fn(),
  read: vi.fn(),
}));
vi.mock("./transactions/use-counter", () => ({ useCounter: worker }));
vi.mock("./thruput/use-counter-value", () => ({ useCounterValue: read }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function setup(signerAddress: string | null = "signer") {
  const config: AppConfig = {
    networkId: "network",
    counterAddress: "counter",
    signerAddress,
    explorerUrl: null,
  };
  worker.mockReturnValue({
    snapshot: { ...initialSnapshot, ready: true, signerBalance: 10_000_000n },
    send,
  });
  read.mockReturnValue({ data: { value: 10n }, error: null });
  return { config, ...render(<ConnectedCounter config={config} />) };
}

it("uses development signing without wallet controls or a success banner", () => {
  const { config } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Increment" }));
  expect(send).toHaveBeenCalledWith("increment");
  expect(worker).toHaveBeenLastCalledWith(config, true);
  expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps reads available but disables updates without a development key", () => {
  setup(null);
  expect(screen.getByTestId("counter-value").textContent).toBe("10");
  expect(screen.queryByText(/· stale/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain(
    "No development signer",
  );
});

it("shows read errors and clears the banner after recovery", () => {
  const { config, rerender } = setup();
  read.mockReturnValue({
    data: { value: 10n },
    error: new Error("Node unavailable"),
  });
  rerender(<ConnectedCounter config={config} />);
  expect(screen.getByRole("alert").textContent).toBe("Node unavailable");
  read.mockReturnValue({ data: { value: 10n }, error: null });
  rerender(<ConnectedCounter config={config} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
