import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  ExecutionEnvelopeComparison,
  WholeWorldWorkload,
} from "./workload-inspector";

describe("whole-world workload inspector", () => {
  test("connects one bit to both persistent banks", () => {
    render(<WholeWorldWorkload />);

    const levels = screen.getByRole("list", { name: "Storage scale levels" });
    expect(within(levels).getAllByRole("button")).toHaveLength(5);
    expect(
      within(levels).getByRole("button", { name: /Selected cell/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 cell × 1 bit = 1 bit")).toBeInTheDocument();

    fireEvent.click(
      within(levels).getByRole("button", { name: /Packed byte/ }),
    );
    expect(screen.getByText("8 cells ÷ 8 = 1 byte")).toBeInTheDocument();

    fireEvent.click(within(levels).getByRole("button", { name: /One row/ }));
    expect(
      screen.getByText("10,000 cells ÷ 8 = 1,250 bytes"),
    ).toBeInTheDocument();

    const bank = within(levels).getByRole("button", { name: /One bank/ });
    fireEvent.click(bank);
    expect(bank).toHaveAttribute("aria-pressed", "true");
    expect(
      within(levels).getByRole("button", { name: /Selected cell/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText("10,000 rows × 1,250 bytes = 12,500,000 bytes"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "One bank materializes every cell in one complete generation. 10,000 rows × 1,250 bytes = 12,500,000 bytes",
      ),
    ).toHaveAttribute("aria-live", "polite");

    fireEvent.click(
      within(levels).getByRole("button", { name: /Persistent world/ }),
    );
    expect(
      screen.getByText("2 banks × 12,500,000 bytes = 25,000,000 bytes"),
    ).toBeInTheDocument();
  });

  test("steps through the fixed read, evaluate, write, and commit phases", () => {
    render(<WholeWorldWorkload />);
    const expectMetric = (label: string, value: string) =>
      expect(screen.getByText(label).nextElementSibling).toHaveTextContent(
        value,
      );

    const phases = screen.getByRole("list", { name: "Atomic tick phases" });
    expect(within(phases).getAllByRole("button")).toHaveLength(4);
    expect(
      within(phases).getByRole("button", { name: /Read source/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expectMetric("Chunk reads", "20,004");
    expectMetric("Bytes read", "12,502,500");
    expectMetric("Rows in window", "3");
    expectMetric("Wraparound bytes", "2,500");

    const evaluate = within(phases).getByRole("button", {
      name: /Evaluate world/,
    });
    fireEvent.click(evaluate);
    expect(evaluate).toHaveAttribute("aria-pressed", "true");
    expect(
      within(phases).getByRole("button", { name: /Read source/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expectMetric("Cell outcomes", "100,000,000");
    expectMetric("Rows evaluated", "10,000");
    expectMetric("Visible working set", "5,000 bytes");
    expectMetric("Destination rows", "10,000");
    expect(
      screen.getByText(/Evaluate world\. Apply the scalar Conway rule/),
    ).toHaveAttribute("aria-live", "polite");

    fireEvent.click(
      within(phases).getByRole("button", { name: /Write destination/ }),
    );
    expectMetric("Chunk writes", "20,000");
    expectMetric("Bytes written", "12,500,000");
    expectMetric("Rows written", "10,000");
    expectMetric("Destination banks", "1 inactive bank");

    fireEvent.click(
      within(phases).getByRole("button", { name: /Commit together/ }),
    );
    expectMetric("Population + digest", "1 each");
    expectMetric("Generation + bank switch", "1 each");
    expectMetric("Queue slot + event", "1 each");
    expectMetric("Partial canonical states", "0");
  });
});

describe("execution envelope comparison", () => {
  test("compares the fixed tick against concrete chain limits", () => {
    render(<ExecutionEnvelopeComparison />);

    const table = screen.getByRole("table", { name: /Game of Life workload/ });
    expect(
      screen.getByRole("region", { name: "Execution evidence comparison" }),
    ).toHaveAttribute("tabindex", "0");
    expect(
      within(table).getByText("10,485,760 bytes max / account"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText(/2,014,240 bytes too large/),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("742,187,500 gas before writes"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("0.014 CU available / cell"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("0.6 gas available / cell"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("Possible on Groundhog"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("Blocked by the transaction compute cap"),
    ).toBeInTheDocument();
    expect(
      within(table).getByText("Blocked by storage gas + compute gas"),
    ).toBeInTheDocument();
    expect(
      within(table).queryByText(/not tested|not benchmarked|no feasibility/i),
    ).toBeNull();

    const sources = screen.getByRole("navigation", {
      name: "Execution comparison sources",
    });
    expect(within(sources).getAllByRole("link")).toHaveLength(7);
    expect(
      within(sources).getByRole("link", { name: "Solana compute budget" }),
    ).toHaveAttribute("href", "https://solana.com/docs/core/fees");
    expect(
      within(sources).getByRole("link", { name: "Solana account limits" }),
    ).toHaveAttribute("href", "https://solana.com/docs/core/accounts");
    expect(
      within(sources).getByRole("link", {
        name: "Solana SBF instruction meter",
      }),
    ).toHaveAttribute(
      "href",
      "https://github.com/anza-xyz/sbpf/blob/v0.13.1/src/vm.rs",
    );
    expect(
      within(sources).getByRole("link", {
        name: "Ethereum storage-access gas",
      }),
    ).toHaveAttribute("href", "https://eips.ethereum.org/EIPS/eip-2930");
    expect(
      within(sources).getByRole("link", { name: "Ethereum opcode gas" }),
    ).toHaveAttribute(
      "href",
      "https://ethereum.org/en/developers/docs/evm/opcodes/",
    );
    expect(screen.queryByRole("button", { name: /tick|run|live/i })).toBeNull();
  });
});
