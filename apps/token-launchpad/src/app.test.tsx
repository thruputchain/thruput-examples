import { fixedBytes } from "@groundhogchain/client";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { CreatePage, Header, ReviewCard, TokensPage } from "@/app";
import {
  readCreatedTokens,
  type FactoryReview,
} from "@/contracts/launchpad-client";
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
          manualProcessing={false}
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
          manualProcessing={false}
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
    ).toHaveAttribute("href", "/my-tokens");
  });

  it("uses one launch action by default and step actions in manual mode", () => {
    const config = configuration();
    const review = {
      ...reviewed(),
      creatorBalance: 1_000n,
      fundingShortfall: 0n,
    };
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    const props = {
      config,
      draft: { name: "Acorn", symbol: "NUT", decimals: "7", supply: "12" },
      review,
      workflow,
      loading: false,
      onAdvance: vi.fn(),
      onReset: vi.fn(),
      writesSupported: true,
    };
    const { rerender } = render(
      <MemoryRouter>
        <ReviewCard {...props} manualProcessing={false} />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Launch token" }),
    ).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ReviewCard {...props} manualProcessing />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Fund token address" }),
    ).toBeInTheDocument();
  });

  it("describes manual submission and recovery accurately while loading", () => {
    const config = configuration();
    const review = {
      ...reviewed(),
      creatorBalance: 1_000n,
      fundingShortfall: 0n,
    };
    const workflow = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      review,
    );
    const props = {
      config,
      draft: { name: "Acorn", symbol: "NUT", decimals: "7", supply: "12" },
      review,
      loading: true,
      onAdvance: vi.fn(),
      onReset: vi.fn(),
      writesSupported: true,
    };
    const { rerender } = render(
      <MemoryRouter>
        <ReviewCard {...props} workflow={workflow} manualProcessing />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Funding token..." }),
    ).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ReviewCard
          {...props}
          workflow={{
            ...workflow,
            funding: {
              status: "committed",
              hash: `0x${"06".repeat(32)}`,
            },
            creation: { status: "signing", hash: null },
          }}
          manualProcessing={false}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Confirming recovery..." }),
    ).toBeInTheDocument();
  });
});

describe("My Tokens", () => {
  it("shows the empty state for a complete empty history", async () => {
    render(
      <MemoryRouter>
        <TokensPage
          config={configuration()}
          client={{} as never}
          scope="mine"
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

  it("loads the global directory without a creator filter", async () => {
    const read = vi.fn().mockResolvedValue({
      tokens: [],
      truncated: false,
      historyLimited: false,
    });
    const config = configuration();
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          read={read}
        />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Tokens" }),
    ).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(expect.anything(), config, {
      creator: null,
    });
    expect(
      screen.getByText("No tokens have been launched through this factory."),
    ).toBeInTheDocument();
  });

  it("ignores a stale directory response after the scope changes", async () => {
    type Result = Awaited<ReturnType<typeof readCreatedTokens>>;
    let resolveAll!: (result: Result) => void;
    let resolveMine!: (result: Result) => void;
    const read = vi.fn(
      (_client, _config, options) =>
        new Promise<Result>((resolve) => {
          if (options?.creator === null) resolveAll = resolve;
          else resolveMine = resolve;
        }),
    );
    const config = configuration();
    const { rerender } = render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          read={read}
        />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="mine"
          read={read}
        />
      </MemoryRouter>,
    );
    await act(async () => {
      resolveMine({
        tokens: [],
        truncated: false,
        historyLimited: false,
      });
    });
    expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
    await act(async () => {
      resolveAll({ tokens: [], truncated: true, historyLimited: false });
    });
    expect(
      screen.queryByText("Showing the newest 100 launches"),
    ).not.toBeInTheDocument();
  });

  it("keeps event evidence visible when current views are partial", async () => {
    render(
      <MemoryRouter>
        <TokensPage
          config={configuration()}
          client={{} as never}
          scope="mine"
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
          scope="mine"
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

describe("launchpad navigation and hero", () => {
  it("orders the directory, wallet directory, and creation links", () => {
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("a"),
    ).toHaveLength(3);
    expect(
      Array.from(
        screen
          .getByRole("navigation", { name: "Primary" })
          .querySelectorAll("a"),
        (link) => link.textContent,
      ),
    ).toEqual(["Tokens", "My Tokens", "Create Token"]);
  });

  it("uses the requested launchpad hero copy without a network badge", () => {
    window.localStorage.clear();
    render(
      <MemoryRouter>
        <CreatePage
          config={configuration()}
          client={{} as never}
          writer={{} as never}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Token Launchpad" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Launch erc20 tokens on groundhog at the click of a button",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Local network")).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Manual transaction processing" }),
    ).not.toBeChecked();
  });
});
