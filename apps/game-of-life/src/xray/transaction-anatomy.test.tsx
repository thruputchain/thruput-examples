import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TransactionAnatomy } from "./transaction-anatomy";

describe("Transaction X-Ray anatomy", () => {
  test("presents the exact contract sequence in order", () => {
    render(<TransactionAnatomy />);
    const stages = within(
      screen.getByRole("list", { name: "Atomic tick stages" }),
    ).getAllByRole("listitem");
    expect(stages).toHaveLength(7);
    expect(
      stages.map((stage) => stage.querySelector("h3")?.textContent),
    ).toEqual([
      "Read required world state",
      "Consume one queued request",
      "Validate transition and stream the active bank",
      "Evaluate and write each row",
      "Switch metadata exclusively",
      "Release capacity and emit evidence",
      "Include the complete transition",
    ]);
    expect(stages[1]).toHaveTextContent(
      /empty queue returns without advancing/,
    );
    expect(stages[1]).toHaveTextContent(
      /later failure restores a consumed request/,
    );
    expect(stages[2]).toHaveTextContent(
      /After queue consumption, check generation overflow and validate active_bank/,
    );
    expect(stages[6]).toHaveTextContent(/never an intermediate bank/);
    for (const stage of stages) {
      expect(stage).toHaveTextContent(/Input:/);
      expect(stage).toHaveTextContent(/Output:/);
      expect(stage).toHaveTextContent(/Authority:/);
      expect(stage).toHaveTextContent(/Source: Contract-derived/);
      expect(stage).toHaveTextContent(/Failure:/);
    }
  });

  test("qualifies queue attribution and the illustrative trace", () => {
    render(<TransactionAnatomy />);
    expect(
      screen.getByText(/Request and processing are separate transactions/),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not necessarily own/)).toBeInTheDocument();
    expect(
      screen.getByText(/illustrative, not a live execution timeline/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/interleaves stages 03 and 04/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/active bank remains immutable input/),
    ).toBeInTheDocument();
  });

  test("shows exact fixed workload derivations without invented measurements", () => {
    render(<TransactionAnatomy />);
    expect(screen.getAllByText("100,000,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("20,004").length).toBeGreaterThan(0);
    expect(screen.getAllByText("20,000").length).toBeGreaterThan(0);
    expect(screen.getByText("5,000 bytes")).toBeInTheDocument();
    expect(screen.getByText("Resulting population counts")).toBeInTheDocument();
    expect(screen.getByText("Streaming state digests")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Why 20,004 reads, not 20,000?" })
        .parentElement,
    ).toHaveTextContent(/6 \+ 19,998 = 20,004 reads/);
    expect(
      screen.getByRole("heading", { name: "Why 20,004 reads, not 20,000?" })
        .parentElement,
    ).toHaveTextContent(/10,002 row loads × 1,250 bytes = 12,502,500 bytes/);
    expect(
      screen.getByRole("heading", { name: "Why 20,004 reads, not 20,000?" })
        .parentElement,
    ).toHaveTextContent(/2,500 bytes beyond one bank/);
    expect(
      screen.getByText(/Receipt measurement not connected/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Actual gas:/).parentElement).toHaveTextContent(
      "Actual gas: Not available",
    );
    expect(
      screen.getByText(/Execution duration:/).parentElement,
    ).toHaveTextContent("Execution duration: Not available");
    expect(screen.getByText(/does not infer consumption/)).toBeInTheDocument();
  });

  test("defines every evidence category", () => {
    render(<TransactionAnatomy />);
    const evidence = within(
      screen.getByRole("heading", { name: "Evidence labels" }).parentElement!,
    );
    for (const label of [
      "Contract-derived",
      "Chain metadata",
      "Indexer-attested provenance",
      "Receipt-measured",
      "Benchmark-measured",
      "Indexer-measured",
      "Configured limit",
      "Illustrative",
    ])
      expect(evidence.getByText(label, { exact: true })).toBeInTheDocument();
  });
});
