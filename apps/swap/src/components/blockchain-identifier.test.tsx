import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { BlockchainIdentifier } from "./blockchain-identifier";

describe("BlockchainIdentifier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a shortened value and exposes the full value in a tooltip", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
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
