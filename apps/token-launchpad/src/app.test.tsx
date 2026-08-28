import { fixedBytes } from "@groundhogchain/client";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ReviewCard, TokensPage } from "@/app";
import type { FactoryReview } from "@/contracts/launchpad-client";
import { createWorkflow } from "@/launch/workflow";
import { configuration } from "@/launch/workflow.test";

function reviewed(): FactoryReview {
  const config = configuration();
  return {
    config: {
      native_token: config.nativeHogAddress,
      token_code_hash: fixedBytes(config.expectedTokenHash, 32),
      required_token_funding: 100n,
      creation_fee: 0n,
      fee_recipient: null,
    },
    predictedAddress: config.factoryAddress,
    predictedAddressHex: `0x${"03".repeat(32)}`,
    currentReserve: 0n,
    fundingAmount: 110n,
    creatorBalance: 10n,
    fundingShortfall: 100n,
  };
}

describe("launch review", () => {
  it("shows exact costs and insufficient-wallet feedback", () => {
    const config = configuration();
    const review = reviewed();
    render(
      <MemoryRouter>
        <ReviewCard
          config={config}
          draft={{ name: "Acorn", symbol: "NUT", decimals: "7", supply: "12" }}
          review={review}
          workflow={createWorkflow(
            config,
            {
              name: "Acorn",
              symbol: "NUT",
              decimals: 7,
              initialSupply: 120_000_000n,
            },
            new Uint8Array(32).fill(5),
            review,
          )}
          loading={false}
          onAdvance={vi.fn()}
          onReset={vi.fn()}
          writesSupported
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("100 HOG units")).toBeInTheDocument();
    expect(screen.getByText("110 HOG units")).toBeInTheDocument();
    expect(screen.getByText("Insufficient HOG")).toBeInTheDocument();
    expect(screen.getByText(/100 more HOG/)).toBeInTheDocument();
  });

  it("shows all progress steps and success navigation", () => {
    const config = configuration();
    const review = {
      ...reviewed(),
      creatorBalance: 1_000n,
      fundingShortfall: 0n,
    };
    const base = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    const workflow = {
      ...base,
      funding: { status: "committed" as const, hash: `0x${"06".repeat(32)}` },
      creation: { status: "committed" as const, hash: `0x${"07".repeat(32)}` },
      verification: {
        status: "complete" as const,
        message: null,
        totalSupply: "12",
        holderBalance: "12",
      },
      createdAddressHex: base.predictedAddressHex,
      creationBlock: "9",
    };
    render(
      <MemoryRouter>
        <ReviewCard
          config={config}
          draft={{
            name: "Acorn",
            symbol: "NUT",
            decimals: "7",
            supply: "0.0000012",
          }}
          review={null}
          workflow={workflow}
          loading={false}
          onAdvance={vi.fn()}
          onReset={vi.fn()}
          writesSupported
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Fund token address")).toBeInTheDocument();
    expect(screen.getByText("Create and initialize token")).toBeInTheDocument();
    expect(screen.getByText("Verify committed token")).toBeInTheDocument();
    expect(screen.getAllByText("complete")).toHaveLength(3);
    expect(screen.getByText("Verified holder balance")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View my tokens" }),
    ).toHaveAttribute("href", "/tokens");
  });
});

describe("My Tokens", () => {
  it("shows the empty state for a complete empty history", async () => {
    render(
      <MemoryRouter>
        <TokensPage
          config={configuration()}
          client={{} as never}
          read={async () => ({
            tokens: [],
            truncated: false,
            historyLimited: false,
          })}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
  });

  it("keeps event evidence visible when current views are partial", async () => {
    render(
      <MemoryRouter>
        <TokensPage
          config={configuration()}
          client={{} as never}
          read={async () => ({
            tokens: [
              {
                addressHex: `0x${"11".repeat(32)}`,
                name: "Wide token",
                symbol: "WIDE",
                decimals: null,
                initialSupply: 12n,
                balance: 7n,
                administratorHex: `0x${"22".repeat(32)}`,
                holderHex: `0x${"33".repeat(32)}`,
                block: 9n,
                transactionHash: `0x${"44".repeat(32)}`,
                readError: true,
              },
            ],
            truncated: true,
            historyLimited: true,
          })}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Wide token")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.getAttribute("data-slot") === "card-description" &&
          element.textContent.includes("Unsupported decimals"),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("12 base units")).toBeInTheDocument();
    expect(
      screen.getByText("Some current balances are unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Showing the newest 100 launches"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Older launch history is unavailable"),
    ).toBeInTheDocument();
  });

  it("shows a bounded complete-history failure", async () => {
    render(
      <MemoryRouter>
        <TokensPage
          config={configuration()}
          client={{} as never}
          read={async () => {
            throw new Error("gateway unavailable");
          }}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("History unavailable")).toBeInTheDocument();
    expect(screen.getByText("gateway unavailable")).toBeInTheDocument();
  });
});
