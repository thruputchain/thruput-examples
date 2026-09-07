import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { BlockchainIdentifier } from "./blockchain-identifier";
import { ExplorerProvider } from "./explorer-context";
import { TokenSymbol } from "./token-symbol";

describe("BlockchainIdentifier", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    ),
  );
  it.each(["address", "transaction"] as const)(
    "links a canonical %s with full focus and hover tooltips",
    async (kind) => {
      const value = `0x${"AB".repeat(32)}`;
      const user = userEvent.setup();
      render(
        <TooltipProvider delayDuration={0}>
          <ExplorerProvider value="https://explorer.test">
            <BlockchainIdentifier kind={kind} value={value} label="Identity" />
          </ExplorerProvider>
        </TooltipProvider>,
      );
      const link = screen.getByRole("link", {
        name: `Identity: ${value} (opens explorer in a new tab)`,
      });
      expect(link).toHaveAttribute(
        "href",
        `https://explorer.test/${kind === "transaction" ? "tx" : "address"}/${value.toLowerCase()}`,
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).not.toHaveTextContent(value);
      await user.tab();
      expect(link).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
      await user.tab();
      await user.hover(link);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
    },
  );

  it.each([
    {
      kind: "identifier" as const,
      value: `0x${"ab".repeat(32)}`,
      explorer: "https://explorer.test",
    },
    {
      kind: "transaction" as const,
      value: "0x1234",
      explorer: "https://explorer.test",
    },
    {
      kind: "address" as const,
      value: `0x${"ab".repeat(32)}/path`,
      explorer: "https://explorer.test",
    },
    {
      kind: "address" as const,
      value: `0x${"ab".repeat(32)}`,
      explorer: undefined,
    },
  ])(
    "does not link generic, invalid, or unconfigured values: $kind $value",
    ({ kind, value, explorer }) => {
      render(
        <TooltipProvider>
          <ExplorerProvider value={explorer}>
            <BlockchainIdentifier kind={kind} value={value} label="Identity" />
          </ExplorerProvider>
        </TooltipProvider>,
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByRole("button")).toHaveAccessibleName(
        `Identity: ${value}`,
      );
    },
  );

  it("preserves full identity in stored fallback symbols without scanning unrelated text", () => {
    const address = `0x${"ab".repeat(32)}`;
    const { rerender } = render(
      <TooltipProvider>
        <ExplorerProvider value="https://explorer.test">
          <TokenSymbol symbol={`${address.slice(0, 8)}...`} address={address} />
        </ExplorerProvider>
      </TooltipProvider>,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      `https://explorer.test/address/${address}`,
    );
    rerender(
      <TooltipProvider>
        <TokenSymbol symbol={`Error for ${address}`} address={address} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(`Error for ${address}`)).toBeVisible();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows a shortened value and exposes the full value in a tooltip", async () => {
    const user = userEvent.setup();
    const value = `0x${"ab".repeat(32)}`;
    render(
      <TooltipProvider>
        <BlockchainIdentifier value={value} label="Transaction hash" />
      </TooltipProvider>,
    );

    const trigger = screen.getByLabelText(`Transaction hash: ${value}`);
    expect(trigger).toHaveTextContent("0xababab…abab");

    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
  });
});
