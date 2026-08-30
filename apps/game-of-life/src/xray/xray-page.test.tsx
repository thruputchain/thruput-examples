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

describe("Transaction X-Ray foundation", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));

  test("renders the exact fixed workload and both storage banks", () => {
    const { container } = render(<XrayPage config={config} />);
    expect(
      screen.getByRole("heading", {
        name: "100,000,000 cells. One atomic transition.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bank A" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bank B" })).toBeInTheDocument();
    expect(screen.getAllByText("Role unknown")).toHaveLength(2);
    expect(screen.getAllByText("12,500,000").length).toBeGreaterThan(0);
    expect(screen.getByText("25,000,000")).toBeInTheDocument();
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(8);
  });

  test("moves the focused explanation across the scale ladder", () => {
    render(<XrayPage config={config} />);
    fireEvent.click(screen.getByRole("button", { name: /Byte/ }));
    expect(screen.getByText("8", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("horizontal cells")).toBeInTheDocument();
    expect(
      screen.getByText(/One canonical byte carries 8 adjacent cells/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Byte/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("uses constant-complexity atlas markup", () => {
    const { container } = render(<XrayPage config={config} />);
    const atlasGraphics = container.querySelectorAll('svg[role="img"]');
    expect(atlasGraphics).toHaveLength(2);
    expect(
      Array.from(atlasGraphics).reduce(
        (total, graphic) => total + graphic.querySelectorAll("*").length,
        0,
      ),
    ).toBeLessThan(30);
    expect(container.querySelectorAll("rect").length).toBeLessThan(20);
  });

  test("maps a submitted cell through the byte and chunk boundaries", () => {
    render(<XrayPage config={config} />);
    fireEvent.change(screen.getByLabelText("Coordinate x"), {
      target: { value: "8000" },
    });
    fireEvent.change(screen.getByLabelText("Coordinate y"), {
      target: { value: "4321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Locate cell" }));

    expect(
      screen.getByLabelText("Bit 0, cell x 8000, selected"),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cell 8000, 4321 maps to chunk 8643, byte 0, bit 0.",
    );
    const bits = within(
      screen.getByRole("list", { name: "Byte 1000 bit positions" }),
    ).getAllByRole("listitem");
    expect(bits).toHaveLength(8);
    expect(bits.map((bit) => bit.getAttribute("aria-label"))).toEqual([
      "Bit 0, cell x 8000, selected",
      "Bit 1, cell x 8001",
      "Bit 2, cell x 8002",
      "Bit 3, cell x 8003",
      "Bit 4, cell x 8004",
      "Bit 5, cell x 8005",
      "Bit 6, cell x 8006",
      "Bit 7, cell x 8007",
    ]);
    expect(screen.getAllByText("Selected · Part 1")).toHaveLength(2);
    expect(screen.getByLabelText("Address derivation")).toHaveTextContent(
      /byte_in_row = floor\(8,000 \/ 8\) = 1,000/,
    );
    expect(screen.getByTestId("bank-a-selected-row")).toHaveAttribute(
      "x",
      "21",
    );
    expect(screen.getByTestId("bank-a-selected-row")).toHaveAttribute(
      "y",
      "43",
    );
    expect(window.location.search).toBe("?cellX=8000&cellY=4321");
  });

  test("preserves the last valid address when form input is invalid", () => {
    render(<XrayPage config={config} />);
    fireEvent.change(screen.getByLabelText("Coordinate x"), {
      target: { value: "10000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Locate cell" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/0 through 9,999/);
    expect(screen.getByLabelText("Coordinate x")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Coordinate y")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cell 5000, 5000 maps to chunk 10000, byte 625, bit 0.",
    );
    expect(window.location.search).toBe("");
  });

  test("hydrates a canonical shareable coordinate from the URL", () => {
    window.history.replaceState(
      null,
      "",
      "/xray?cellX=9999&cellY=9999&view=proof",
    );
    render(<XrayPage config={config} />);
    expect(screen.getByLabelText("Coordinate x")).toHaveValue("9999");
    expect(screen.getByLabelText("Coordinate y")).toHaveValue("9999");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cell 9999, 9999 maps to chunk 19999, byte 249, bit 7.",
    );
  });

  test("cross-highlights microscope address fields from the scale ladder", () => {
    const { container } = render(<XrayPage config={config} />);
    fireEvent.click(screen.getByRole("button", { name: /Chunk/ }));
    const microscope = container.querySelector(
      'section[data-scale-focus="chunk"]',
    );
    expect(microscope).not.toBeNull();
    expect(microscope!.querySelectorAll('[data-focused="true"]')).toHaveLength(
      3,
    );
  });
});
