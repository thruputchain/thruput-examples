import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
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
  test("renders the exact fixed workload and both storage banks", () => {
    render(<XrayPage config={config} />);
    expect(
      screen.getByRole("heading", {
        name: "100,000,000 cells. One atomic transition.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bank A" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bank B" })).toBeInTheDocument();
    expect(screen.getAllByText("12,500,000").length).toBeGreaterThan(0);
    expect(screen.getByText("25,000,000")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(8);
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
});
