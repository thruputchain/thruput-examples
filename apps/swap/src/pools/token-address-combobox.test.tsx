import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDiscoveryTokens } from "@/token-discovery/client";
import type { DiscoveryResponse } from "@/token-discovery/wire";
import { TokenAddressCombobox } from "./token-address-combobox";

vi.mock("@/token-discovery/client", () => ({ getDiscoveryTokens: vi.fn() }));
const a = `0x${"01".repeat(32)}`;
const b = `0x${"02".repeat(32)}`;
const scope = {
  networkId: "00".repeat(32),
  factoryAddress: a,
  tokenCodeHash: b,
};
const discovery = { enabled: true, scope, factoryAddress: a, tokenCodeHash: b };
const response: DiscoveryResponse = {
  scope,
  tokens: [a, b].map((tokenAddress) => ({
    tokenAddress,
    creatorAddress: a,
    name: "Same Name",
    symbol: "SAME",
    decimals: null,
  })),
  hasMore: false,
  historyLimited: false,
  syncState: "idle",
};

function Control({ enabled = true, other = "", initial = "" }) {
  const [value, setValue] = useState(initial);
  return (
    <TokenAddressCombobox
      label="Token A"
      value={value}
      otherAddress={other}
      discovery={enabled ? discovery : undefined}
      onChange={setValue}
    />
  );
}

beforeEach(() => {
  vi.mocked(getDiscoveryTokens).mockReset().mockResolvedValue(response);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("token address combobox", () => {
  it("opens newest suggestions, navigates by keyboard, selects and returns focus", async () => {
    const user = userEvent.setup();
    render(<Control />);
    const trigger = screen.getByRole("button", { name: "Search Token A" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("combobox", { name: "Search Token A" }),
    ).toHaveFocus();
    await screen.findAllByRole("option");
    expect(getDiscoveryTokens).toHaveBeenCalledWith(
      discovery,
      "",
      expect.any(AbortSignal),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByLabelText("Contract address")).toHaveValue(b);
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps server matches for creator searches without filtering, including notices and selection", async () => {
    vi.mocked(getDiscoveryTokens).mockResolvedValue({
      ...response,
      hasMore: true,
      historyLimited: true,
      syncState: "retrying",
    });
    const user = userEvent.setup();
    render(<Control initial={a} other={b} />);
    await user.click(screen.getByRole("button", { name: "Search Token A" }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "creator not in labels" },
    });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(a);
    expect(options[0]).toHaveTextContent("selected");
    expect(options[1]).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/newest 20/)).toBeVisible();
    expect(screen.getByText(/retained indexed history/)).toBeVisible();
    expect(screen.getByText(/registry is retrying/)).toBeVisible();
    expect(screen.getByLabelText("Contract address")).toHaveValue(a);
  });

  it.each([false, true])(
    "offers a valid unindexed address with discovery enabled=%s and failures",
    async (enabled) => {
      vi.mocked(getDiscoveryTokens).mockRejectedValue(new Error("offline"));
      const user = userEvent.setup();
      render(<Control enabled={enabled} />);
      await user.click(screen.getByRole("button", { name: "Search Token A" }));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: a } });
      if (enabled)
        expect(
          await screen.findByText(/Token discovery is unavailable/),
        ).toBeVisible();
      else expect(getDiscoveryTokens).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("option", { name: `Use address ${a}` }),
      );
      expect(screen.getByLabelText("Contract address")).toHaveValue(a);
    },
  );

  it("rejects zero and duplicate manual addresses, and clears the old address on incomplete editing", async () => {
    const user = userEvent.setup();
    render(<Control enabled={false} initial={a} other={b} />);
    fireEvent.change(screen.getByLabelText("Contract address"), {
      target: { value: "0x" },
    });
    expect(screen.getByLabelText("Contract address")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Search Token A" }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: `0x${"0".repeat(64)}` },
    });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: b } });
    expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByLabelText("Contract address"), {
      target: { value: b },
    });
    expect(screen.getByText(/Choose a different contract/)).toBeVisible();
  });

  it("debounces, aborts superseded searches and ignores late results, then retries errors", async () => {
    const user = userEvent.setup();
    let resolveOld!: (value: DiscoveryResponse) => void;
    vi.mocked(getDiscoveryTokens).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    render(<Control />);
    await user.click(screen.getByRole("button", { name: "Search Token A" }));
    await waitFor(() => expect(getDiscoveryTokens).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(getDiscoveryTokens).mock.calls[0]![2]!;
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "n" } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "new" },
    });
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(getDiscoveryTokens).toHaveBeenCalledTimes(1);
    vi.mocked(getDiscoveryTokens).mockResolvedValueOnce({
      ...response,
      tokens: [],
    });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(response));
    expect(screen.getByText(/No indexed matches/)).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    vi.mocked(getDiscoveryTokens).mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "next" },
    });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
