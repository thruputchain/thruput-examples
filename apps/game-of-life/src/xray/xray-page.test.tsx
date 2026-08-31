import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { ReadAppConfig } from "@/config";
import { XrayPage } from "./xray-page";

const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  rpcProxyPath: "/groundhog-rpc",
  networkId: "aa".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  indexerUrl: new URL("http://127.0.0.1:8787"),
  indexerProxyPath: "/groundhog-indexer/",
} satisfies ReadAppConfig;

describe("Transaction X-Ray workbench", () => {
  beforeEach(() => window.history.replaceState(null, "", "/xray"));

  test("presents one connected cell and storage debugger", () => {
    const { container } = render(<XrayPage config={config} />);

    expect(
      screen.getByRole("heading", { name: "Transaction X-Ray" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "3 × 3 neighborhood" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "One cell, one bit, the same address next generation",
      }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("list", { name: "Selected cell neighborhood" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(9);
    expect(
      within(
        screen.getByRole("list", { name: "Byte 625 bit values" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(8);
    expect(
      within(
        screen.getByRole("list", { name: "Byte 625 bit values" }),
      ).getAllByRole("listitem")[0],
    ).toHaveAccessibleName(/^Bit 0: not loaded/);
    expect(screen.getByText("x 0–7,999")).toBeInTheDocument();
    expect(screen.getByText("625 − 0")).toBeInTheDocument();
    expect(screen.getByText("5,000 × 2 + 0")).toBeInTheDocument();
    expect(
      screen.getByText("The left chunk starts at row byte 0", {
        exact: false,
      }),
    ).toHaveTextContent("byte 625 inside the chunk");
    expect(
      screen.queryByRole("list", { name: "Cell journey stages" }),
    ).toBeNull();
    expect(screen.queryByText("COMMIT BOUNDARY")).toBeNull();
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(0);
  });

  test("shows substituted packed-storage calculations", () => {
    window.history.replaceState(
      null,
      "",
      "/xray?cellX=8657&cellY=3009&view=proof",
    );
    render(<XrayPage config={config} />);

    expect(
      screen.getByRole("heading", { name: "Find the byte" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("One byte holds 8 cells.", { exact: false }),
    ).toHaveTextContent("Cell x 8,657 is stored in byte 1,082.");
    expect(
      screen.getByRole("heading", { name: "Find the bit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This is position 2 of 8", { exact: false }),
    ).toHaveTextContent("stored as bit 1");
    expect(
      screen.getByRole("heading", { name: "Choose the row chunk" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Find the byte inside the chunk" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Build the storage key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The right chunk starts at row byte 1,000", {
        exact: false,
      }),
    ).toHaveTextContent("byte 82 inside the chunk");
    expect(
      screen.getByText("Every row has two chunk keys.", { exact: false }),
    ).toHaveTextContent("right chunk uses key 6,019");
    expect(screen.getByText("floor(8,657 ÷ 8)")).toBeInTheDocument();
    expect(screen.getByText("8,657 mod 8")).toBeInTheDocument();
    expect(screen.getByText("x 8,000–9,999")).toBeInTheDocument();
    expect(screen.getByText("1,082 − 1,000")).toBeInTheDocument();
    expect(screen.getByText("3,009 × 2 + 1")).toBeInTheDocument();
    expect(
      screen.getByText("Same location:", { exact: false }),
    ).toHaveTextContent("row 3,009 / key 6,019 / byte 82 / bit 1");
    expect(
      screen.getByRole("listitem", {
        name: /Bit 1: not loaded, selected cell/,
      }),
    ).toHaveAttribute("aria-current", "true");
  });

  test("preserves the last valid address when input is invalid", () => {
    render(<XrayPage config={config} />);
    fireEvent.change(screen.getByLabelText("Coordinate x"), {
      target: { value: "10000" },
    });
    fireEvent.submit(screen.getByLabelText("Coordinate x").closest("form")!);

    expect(screen.getByRole("alert")).toHaveTextContent(/0 through 9,999/);
    expect(screen.getByLabelText("Coordinate x")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByText(/Generation — \/ cell 5,000,5,000/),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  test("updates valid address state without loading exact data", () => {
    render(<XrayPage config={config} />);
    fireEvent.change(screen.getByLabelText("Coordinate x"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("Coordinate y"), {
      target: { value: "34" },
    });

    expect(screen.getByText(/Generation — \/ cell 12,34/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "No exact cell data loaded.",
    );
    expect(screen.getByText("34 × 2 + 0")).toBeInTheDocument();
    expect(window.location.search).toBe("?cellX=12&cellY=34");
  });
});
