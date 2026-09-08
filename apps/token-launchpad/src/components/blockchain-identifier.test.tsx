import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  BlockchainIdentifier,
  ExplorerProvider,
} from "./blockchain-identifier";

const value = `0x${"aB".repeat(32)}`;
describe("BlockchainIdentifier", () => {
  it.each([
    ["12345678901234", "12345678901234"],
    ["123456789012345", "12345678\u20262345"],
  ])(
    "shortens only values longer than fourteen characters: %s",
    (value, expected) => {
      render(
        <ExplorerProvider>
          <BlockchainIdentifier kind="identifier" value={value} />
        </ExplorerProvider>,
      );
      expect(screen.getByLabelText(value)).toHaveTextContent(expected);
    },
  );
  it.each(["address", "transaction"] as const)(
    "links the complete canonical %s and shows a keyboard tooltip",
    async (kind) => {
      const user = userEvent.setup();
      const { container } = render(
        <ExplorerProvider explorerUrl="https://EXPLORER.test/">
          <BlockchainIdentifier kind={kind} value={value} />
        </ExplorerProvider>,
      );
      const link = screen.getByRole("link", {
        name: `${value} (opens in new tab)`,
      });
      expect(link).toHaveAttribute(
        "href",
        `https://explorer.test/${kind === "transaction" ? "tx" : "address"}/${value.toLowerCase()}`,
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveTextContent(
        `${value.slice(0, 8)}\u2026${value.slice(-4)}`,
      );
      expect(container.textContent).not.toContain(value);
      await user.tab();
      expect(link).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(container.querySelector("button a, a button, [title]")).toBeNull();
    },
  );
  it("normalizes unprefixed hex only for explicitly typed links", () => {
    render(
      <ExplorerProvider explorerUrl="https://explorer.test">
        <BlockchainIdentifier kind="transaction" value={value.slice(2)} />
      </ExplorerProvider>,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      `https://explorer.test/tx/${value.toLowerCase()}`,
    );
  });
  it.each([undefined, "", "http://remote.test", "https://example.test/path"])(
    "keeps hover/focus tooltips without a valid explorer: %s",
    async (explorerUrl) => {
      const user = userEvent.setup();
      render(
        <ExplorerProvider explorerUrl={explorerUrl}>
          <BlockchainIdentifier kind="address" value={value} />
        </ExplorerProvider>,
      );
      expect(screen.queryByRole("link")).toBeNull();
      const trigger = screen.getByLabelText(value);
      await user.hover(trigger);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
      await user.unhover(trigger);
      await user.tab();
      expect(trigger).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
    },
  );
  it.each([value, "nonce", "implementation hash"])(
    "never links generic identifiers: %s",
    (value) => {
      render(
        <ExplorerProvider explorerUrl="https://explorer.test">
          <BlockchainIdentifier kind="identifier" value={value} />
        </ExplorerProvider>,
      );
      expect(screen.queryByRole("link")).toBeNull();
    },
  );
  it.each([`${value}\n`, `${value}/path`, `0x${"a".repeat(40)}`, "invalid"])(
    "never links invalid typed values: %s",
    (value) => {
      render(
        <ExplorerProvider explorerUrl="https://explorer.test">
          <BlockchainIdentifier kind="transaction" value={value} />
        </ExplorerProvider>,
      );
      expect(screen.queryByRole("link")).toBeNull();
    },
  );
});
