import { fixedBytes } from "@groundhogchain/client";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  CreatePage,
  Header,
  LaunchpadRoutes,
  ReviewCard,
  TokensPage,
} from "@/app";
import {
  readCreatedTokens,
  type FactoryReview,
} from "@/contracts/launchpad-client";
import * as launchpadClient from "@/contracts/launchpad-client";
import { registryTokenToCreatedToken } from "@/registry/tokens";
import {
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  workflowStorageKey,
} from "@/launch/workflow";
import { configuration } from "@/launch/workflow.test";
import { runWorkflow } from "@/launch/executor";
import type {
  RegistryStatus,
  RegistryToken,
  RegistryTokenPage,
} from "@/registry/client";

vi.mock("@/launch/executor", () => ({ runWorkflow: vi.fn() }));

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
    reserveHeight: 0n,
    fundingAmount: 110n,
    creatorBalance: 10n,
    fundingShortfall: 100n,
  };
}

describe("launch review", () => {
  it("links every typed review identifier and preserves full-value copy success and failure", async () => {
    const user = userEvent.setup();
    const config = {
      ...configuration(),
      explorerUrl: "https://explorer.test/",
    };
    const base = createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      reviewed(),
    );
    const workflow = {
      ...base,
      funding: { status: "committed" as const, hash: `0x${"06".repeat(32)}` },
      creation: { status: "committed" as const, hash: `0x${"07".repeat(32)}` },
      createdAddressHex: `0x${"ab".repeat(32)}`,
    };
    const { container } = render(
      <MemoryRouter>
        <ReviewCard
          config={config}
          draft={{ name: "Acorn", symbol: "NUT", decimals: "7", supply: "12" }}
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
    const links = screen
      .getAllByRole("link")
      .filter((link) => link.hasAttribute("target"));
    expect(links).toHaveLength(9);
    for (const hash of [workflow.funding.hash, workflow.creation.hash]) {
      expect(
        links.filter(
          (link) =>
            link.getAttribute("href") === `https://explorer.test/tx/${hash}`,
        ),
      ).toHaveLength(2);
    }
    for (const address of [
      workflow.predictedAddressHex,
      workflow.reviewedNativeTokenHex,
      workflow.createdAddressHex,
    ]) {
      expect(
        links.some(
          (link) =>
            link.getAttribute("href") ===
            `https://explorer.test/address/${address}`,
        ),
      ).toBe(true);
    }
    for (const label of ["Administrator", "Initial holder"]) {
      expect(
        screen.getByText(label).parentElement?.querySelector("a"),
      ).toHaveAttribute(
        "href",
        `https://explorer.test/address/0x${"02".repeat(32)}`,
      );
    }
    for (const label of ["Application nonce", "Implementation hash"]) {
      expect(
        screen.getByText(label).parentElement?.querySelector("a"),
      ).toBeNull();
    }
    expect(
      container.querySelector("button a, a button, button button, [title]"),
    ).toBeNull();
    const copy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("denied"));
    try {
      await user.click(
        screen.getByRole("button", {
          name: `Copy Token contract: ${workflow.createdAddressHex}`,
        }),
      );
      expect(copy).toHaveBeenLastCalledWith(workflow.createdAddressHex);
      expect(screen.getByText("Copied")).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", {
          name: `Copy Token contract: ${workflow.createdAddressHex}`,
        }),
      );
      expect(screen.getByText("Copy failed")).toBeInTheDocument();
    } finally {
      copy.mockRestore();
    }
  });

  it.each([
    [false, "all"],
    [false, "mine"],
    [true, "all"],
    [true, "mine"],
  ] as const)(
    "links existing directory rows with registry=%s scope=%s",
    async (registryEnabled, scope) => {
      const user = userEvent.setup();
      const token = registryToken();
      const { container } = render(
        <MemoryRouter>
          <TokensPage
            config={{
              ...configuration(),
              registryEnabled,
              explorerUrl: "https://explorer.test",
            }}
            client={{} as never}
            scope={scope}
            read={async () => ({
              tokens: [registryTokenToCreatedToken(token)],
              truncated: false,
              historyLimited: false,
            })}
            registryRead={async () => registryPage([token])}
            registryStatus={async () => registryStatus()}
            registrySync={async () => registryStatus()}
            enrichBalances={async (_client, _config, tokens) => [...tokens]}
          />
        </MemoryRouter>,
      );
      await screen.findByText("NUT");
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(2);
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        `https://explorer.test/address/${token.administratorAddress}`,
        `https://explorer.test/address/${token.tokenAddress}`,
      ]);
      expect(container.querySelector("button a, a button")).toBeNull();
      const copy = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("denied"));
      try {
        const navigate = vi.fn();
        container.addEventListener("click", (event) => {
          if ((event.target as Element).closest("a")) navigate();
        });
        await user.click(
          screen.getByRole("button", { name: "Copy token address" }),
        );
        expect(copy).toHaveBeenNthCalledWith(1, token.tokenAddress);
        expect(screen.getByText("Copied")).toHaveAttribute("role", "status");
        await user.click(
          screen.getByRole("button", { name: "Copy token address" }),
        );
        expect(copy).toHaveBeenNthCalledWith(2, token.tokenAddress);
        expect(screen.getByText("Copy failed")).toHaveAttribute(
          "role",
          "status",
        );
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
      }
    },
  );
  it.each(["complete", "unmount", "replace client"])(
    "freezes a deferred review and rejects stale completion: %s",
    async (action) => {
      const config = configuration();
      const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: async (_name: string, callback: () => unknown) => callback(),
        },
      });
      let resolve!: (value: FactoryReview) => void;
      const review = vi.spyOn(launchpadClient, "reviewFactory").mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const writer = { execute: vi.fn(), observe: vi.fn() };
      const client = {} as never;
      const { unmount, rerender, container } = render(
        <MemoryRouter>
          <CreatePage config={config} client={client} writer={writer} />
        </MemoryRouter>,
      );
      try {
        fireEvent.change(screen.getByLabelText("Token name"), {
          target: { value: "Acorn" },
        });
        fireEvent.change(screen.getByLabelText("Symbol"), {
          target: { value: "NUT" },
        });
        fireEvent.submit(container.querySelector("form")!);
        await waitFor(() => expect(review).toHaveBeenCalledOnce());
        for (const label of [
          "Token name",
          "Symbol",
          "Decimals",
          "Initial supply",
        ]) {
          expect(screen.getByLabelText(label)).toBeDisabled();
        }
        fireEvent.change(screen.getByLabelText("Token name"), {
          target: { value: "Changed" },
        });
        fireEvent.submit(container.querySelector("form")!);
        expect(review).toHaveBeenCalledOnce();
        if (action === "unmount") unmount();
        if (action === "replace client")
          rerender(
            <MemoryRouter>
              <CreatePage
                config={config}
                client={{} as never}
                writer={writer}
              />
            </MemoryRouter>,
          );
        await act(async () => resolve(reviewed()));
        const stored = loadWorkflow(localStorage, workflowStorageKey(config));
        if (action === "complete") {
          expect(stored?.token.name).toBe("Acorn");
          expect(screen.getByText("Acorn · 7 decimals")).toBeInTheDocument();
          expect(screen.getByLabelText("Token name")).toHaveValue("Acorn");
        } else {
          expect(stored).toBeNull();
          expect(
            screen.queryByRole("button", { name: "Launch token" }),
          ).not.toBeInTheDocument();
        }
        expect(writer.execute).not.toHaveBeenCalled();
      } finally {
        unmount();
        localStorage.clear();
        review.mockRestore();
        if (originalLocks)
          Object.defineProperty(navigator, "locks", originalLocks);
        else Reflect.deleteProperty(navigator, "locks");
      }
    },
  );
  it("associates field guidance and validation errors with each input", () => {
    const { container } = render(
      <MemoryRouter>
        <CreatePage
          config={configuration()}
          client={{} as never}
          writer={{} as never}
        />
      </MemoryRouter>,
    );
    const fields = [
      ["symbol", "Symbol"],
      ["name", "Token name"],
      ["decimals", "Decimals"],
      ["supply", "Initial supply"],
    ] as const;
    for (const [id, label] of fields) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-describedby",
        `${id}-description`,
      );
    }
    fireEvent.change(screen.getByLabelText("Decimals"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Initial supply"), {
      target: { value: "" },
    });

    fireEvent.submit(container.querySelector("form")!);

    for (const [id, label] of fields) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-describedby",
        `${id}-description ${id}-error`,
      );
      expect(document.getElementById(`${id}-error`)).not.toBeEmptyDOMElement();
    }
  });

  it("shows exact costs and insufficient-wallet feedback", () => {
    const config = configuration();
    const review = reviewed();
    render(
      <MemoryRouter>
        <ReviewCard
          config={config}
          draft={{
            name: "Changed",
            symbol: "BAD",
            decimals: "2",
            supply: "999",
          }}
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
    expect(screen.getByText("Acorn · 7 decimals")).toBeInTheDocument();
    expect(screen.getByText("NUT")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.queryByText("BAD")).not.toBeInTheDocument();
    expect(screen.getByText("110 HOG units")).toBeInTheDocument();
    expect(screen.getByText("Insufficient HOG")).toBeInTheDocument();
    expect(screen.getByText(/100 more HOG/)).toBeInTheDocument();
  });

  it.each([undefined, "https://swap.example.test"])(
    "shows success navigation with Swap origin %s",
    (swapAppUrl) => {
      const config = { ...configuration(), swapAppUrl: swapAppUrl ?? null };
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
        creation: {
          status: "committed" as const,
          hash: `0x${"07".repeat(32)}`,
        },
        verification: {
          status: "complete" as const,
          message: null,
          totalSupply: "12",
          holderBalance: "12",
        },
        createdAddressHex: `0x${"aB".repeat(32)}`,
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
      expect(
        screen.getByText("Create and initialize token"),
      ).toBeInTheDocument();
      expect(screen.getByText("Verify committed token")).toBeInTheDocument();
      expect(screen.getAllByText("complete")).toHaveLength(3);
      expect(screen.getByText("Verified holder balance")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "View my tokens" }),
      ).toHaveAttribute("href", "/my-tokens");
      const link = screen.queryByRole("link", { name: "Create AMM Pool" });
      if (swapAppUrl) {
        expect(link).toHaveAttribute(
          "href",
          `${swapAppUrl}/pools/new?tokenA=${workflow.createdAddressHex.toLowerCase()}`,
        );
        expect(link).toHaveAttribute("data-slot", "button");
        expect(link).not.toHaveAttribute("target");
      } else {
        expect(link).not.toBeInTheDocument();
      }
    },
  );

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
    expect(
      screen.getByRole("button", { name: "Edit token details" }),
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

  it("allows an invalid saved workflow to be discarded", async () => {
    const user = userEvent.setup();
    const config = configuration();
    const key = workflowStorageKey(config);
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, action: () => Promise<unknown>) =>
          action(),
      },
    });
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        funding: { status: "idle", hash: null },
        creation: { status: "idle", hash: null },
        createdAddressHex: null,
        creationBlock: null,
        verification: {
          status: "pending",
          message: null,
          totalSupply: null,
          holderBalance: null,
        },
      }),
    );
    try {
      render(
        <MemoryRouter>
          <CreatePage
            config={config}
            client={{} as never}
            writer={{} as never}
          />
        </MemoryRouter>,
      );
      await user.click(
        screen.getByRole("button", {
          name: "Discard invalid saved workflow",
        }),
      );
      await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
      expect(
        screen.getByRole("button", { name: "Review launch" }),
      ).toBeEnabled();
    } finally {
      window.localStorage.clear();
      if (originalLocks) {
        Object.defineProperty(navigator, "locks", originalLocks);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
    }
  });

  it("does not offer to discard ambiguous invalid workflow evidence", () => {
    const config = configuration();
    window.localStorage.setItem(
      workflowStorageKey(config),
      JSON.stringify({
        version: 1,
        funding: { status: "committed", hash: `0x${"06".repeat(32)}` },
        creation: { status: "pending", hash: `0x${"07".repeat(32)}` },
      }),
    );
    try {
      render(
        <MemoryRouter>
          <CreatePage
            config={config}
            client={{} as never}
            writer={{} as never}
          />
        </MemoryRouter>,
      );
      expect(
        screen.queryByRole("button", {
          name: "Discard invalid saved workflow",
        }),
      ).not.toBeInTheDocument();
    } finally {
      window.localStorage.clear();
    }
  });

  it("requests a best-effort registry sync only after creation commits", async () => {
    const user = userEvent.setup();
    const config = {
      ...configuration(),
      registryEnabled: true,
      swapAppUrl: "https://swap.example.test",
    };
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
    const committed = {
      ...workflow,
      funding: { status: "committed" as const, hash: `0x${"06".repeat(32)}` },
      creation: { status: "committed" as const, hash: `0x${"07".repeat(32)}` },
      verification: {
        status: "incomplete" as const,
        message: null,
        totalSupply: "12",
        holderBalance: "12",
      },
      createdAddressHex: workflow.predictedAddressHex,
      creationBlock: "9",
    };
    saveWorkflowForTest(config, workflow);
    vi.mocked(runWorkflow)
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce({
        ...committed,
        verification: { ...committed.verification, status: "complete" },
      });
    const requestSync = vi.fn().mockRejectedValue(new Error("offline"));
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, action: () => unknown) => action(),
      },
    });
    try {
      render(
        <MemoryRouter>
          <CreatePage
            config={config}
            client={{} as never}
            writer={{} as never}
            requestSync={requestSync}
          />
        </MemoryRouter>,
      );
      expect(
        screen.queryByRole("link", { name: "Create AMM Pool" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Launch token" }));
      expect(await screen.findByText("Token created")).toBeInTheDocument();
      expect(requestSync).toHaveBeenCalledWith(config);
      expect(screen.queryByText("offline")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Create AMM Pool" }),
      ).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Retry verification" }),
      );
      expect(
        await screen.findByRole("link", { name: "Create AMM Pool" }),
      ).toHaveAttribute(
        "href",
        `${config.swapAppUrl}/pools/new?tokenA=${committed.createdAddressHex}`,
      );
      expect(requestSync).toHaveBeenCalledTimes(1);
    } finally {
      window.localStorage.clear();
      if (originalLocks)
        Object.defineProperty(navigator, "locks", originalLocks);
      else Reflect.deleteProperty(navigator, "locks");
    }
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
    expect(await screen.findByText("WIDE")).toHaveAttribute(
      "data-slot",
      "card-title",
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.getAttribute("data-slot") === "card-description" &&
          element.textContent.includes("Wide token ·"),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Initial holder")).not.toBeInTheDocument();
    expect(screen.queryByText("Transaction")).not.toBeInTheDocument();
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

  it("renders registry metadata before scoped balance enrichment", async () => {
    const config = { ...configuration(), registryEnabled: true };
    let resolveBalances!: (tokens: never[]) => void;
    const enrichBalances = vi.fn(
      () => new Promise<never[]>((resolve) => (resolveBalances = resolve)),
    );
    const registryRead = vi
      .fn()
      .mockResolvedValue(registryPage([registryToken()]));
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="mine"
          registryRead={registryRead}
          registryStatus={vi.fn().mockResolvedValue(registryStatus())}
          enrichBalances={enrichBalances}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("NUT")).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(registryRead).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        creator: `0x${"02".repeat(32)}`,
        limit: 20,
        offset: 0,
      }),
      expect.any(AbortSignal),
    );
    resolveBalances([]);
  });

  it("debounces search and distinguishes no matches", async () => {
    vi.useFakeTimers();
    const config = { ...configuration(), registryEnabled: true };
    const registryRead = vi.fn().mockResolvedValue(registryPage([]));
    try {
      render(
        <MemoryRouter>
          <TokensPage
            config={config}
            client={{} as never}
            scope="all"
            registryRead={registryRead}
            registryStatus={vi.fn().mockResolvedValue(registryStatus())}
            enrichBalances={vi.fn().mockResolvedValue([])}
          />
        </MemoryRouter>,
      );
      await act(async () => undefined);
      expect(registryRead).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("Search tokens"), {
        target: { value: "Acorn" },
      });
      await act(async () => vi.advanceTimersByTime(299));
      expect(registryRead).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(1));
      await act(async () => undefined);
      expect(registryRead).toHaveBeenLastCalledWith(
        config,
        expect.objectContaining({ q: "Acorn", offset: 0 }),
        expect.any(AbortSignal),
      );
      expect(screen.getByText("No matching tokens")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses the snapshot for pagination and resets it when sorting", async () => {
    const user = userEvent.setup();
    const config = { ...configuration(), registryEnabled: true };
    const registryRead = vi
      .fn()
      .mockResolvedValueOnce(
        registryPage([registryToken()], { total: 21, hasMore: true }),
      )
      .mockResolvedValueOnce(
        registryPage([registryToken()], {
          total: 21,
          offset: 20,
          hasMore: false,
        }),
      )
      .mockResolvedValueOnce(registryPage([]));
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          registryRead={registryRead}
          registryStatus={vi.fn().mockResolvedValue(registryStatus())}
          enrichBalances={vi
            .fn()
            .mockImplementation(async (_client, _config, tokens) => tokens)}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(registryRead).toHaveBeenCalledTimes(2));
    expect(registryRead.mock.calls[1]?.[1]).toMatchObject({
      offset: 20,
      asOfBlock: "12",
    });
    await user.selectOptions(screen.getByLabelText("Sort by"), "oldest");
    await waitFor(() => expect(registryRead).toHaveBeenCalledTimes(3));
    expect(registryRead.mock.calls[2]?.[1]).toEqual({
      sort: "oldest",
      limit: 20,
      offset: 0,
    });
  });

  it("aborts superseded requests and suppresses stale balance results", async () => {
    const user = userEvent.setup();
    const config = { ...configuration(), registryEnabled: true };
    const firstToken = registryToken();
    const secondToken = {
      ...registryToken(),
      tokenAddress: `0x${"08".repeat(32)}`,
      name: "Beech",
      symbol: "BCH",
    };
    let resolveFirstBalances!: (tokens: never[]) => void;
    const enrichBalances = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<never[]>((resolve) => (resolveFirstBalances = resolve)),
      )
      .mockImplementationOnce(async (_client, _config, tokens) => tokens);
    const registryRead = vi
      .fn()
      .mockResolvedValueOnce(registryPage([firstToken]))
      .mockResolvedValueOnce(registryPage([secondToken]));
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          registryRead={registryRead}
          registryStatus={vi.fn().mockResolvedValue(registryStatus())}
          enrichBalances={enrichBalances}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("NUT")).toBeInTheDocument();
    const firstSignal = registryRead.mock.calls[0]?.[2] as AbortSignal;
    await user.selectOptions(screen.getByLabelText("Sort by"), "name");
    expect(await screen.findByText("BCH")).toBeInTheDocument();
    expect(firstSignal.aborted).toBe(true);
    resolveFirstBalances([]);
    await act(async () => undefined);
    expect(screen.getByText("BCH")).toBeInTheDocument();
    expect(screen.queryByText("NUT")).not.toBeInTheDocument();
  });

  it("surfaces integrity and incomplete-history status", async () => {
    const config = { ...configuration(), registryEnabled: true };
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          registryRead={vi.fn().mockResolvedValue(registryPage([]))}
          registryStatus={vi.fn().mockResolvedValue({
            ...registryStatus(),
            syncState: "integrityFault",
            historyLimited: true,
            lastError: "Conflicting immutable evidence",
          })}
          enrichBalances={vi.fn().mockResolvedValue([])}
        />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Registry integrity fault"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Older launch history is unavailable"),
    ).toBeInTheDocument();
  });

  it("refreshes an initially empty snapshot when sync completes and stops polling", async () => {
    vi.useFakeTimers();
    const config = { ...configuration(), registryEnabled: true };
    const registryRead = vi
      .fn()
      .mockResolvedValueOnce(registryPage([]))
      .mockResolvedValueOnce(registryPage([registryToken()]));
    const readStatus = vi.fn().mockResolvedValue(registryStatus());
    const registrySync = vi.fn().mockResolvedValue({
      ...registryStatus(),
      syncState: "syncing",
      syncing: true,
    });
    try {
      render(
        <MemoryRouter>
          <TokensPage
            config={config}
            client={{} as never}
            scope="all"
            registryRead={registryRead}
            registryStatus={readStatus}
            registrySync={registrySync}
            enrichBalances={vi
              .fn()
              .mockImplementation(async (_client, _config, tokens) => tokens)}
          />
        </MemoryRouter>,
      );
      await act(async () => undefined);
      expect(screen.getByText("No tokens yet")).toBeInTheDocument();
      expect(registrySync).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(screen.getByText("NUT")).toBeInTheDocument();
      expect(registryRead).toHaveBeenCalledTimes(2);
      expect(registryRead.mock.calls[1]?.[1]).not.toHaveProperty("asOfBlock");
      expect(readStatus).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(readStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed status poll and refreshes when sync completes", async () => {
    vi.useFakeTimers();
    const config = { ...configuration(), registryEnabled: true };
    const registryRead = vi
      .fn()
      .mockResolvedValueOnce(registryPage([]))
      .mockResolvedValueOnce(registryPage([registryToken()]));
    const readStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(registryStatus());
    const registrySync = vi.fn().mockResolvedValue({
      ...registryStatus(),
      syncState: "syncing",
      syncing: true,
    });
    try {
      render(
        <MemoryRouter>
          <TokensPage
            config={config}
            client={{} as never}
            scope="all"
            registryRead={registryRead}
            registryStatus={readStatus}
            registrySync={registrySync}
            enrichBalances={vi
              .fn()
              .mockImplementation(async (_client, _config, tokens) => tokens)}
          />
        </MemoryRouter>,
      );
      await act(async () => undefined);

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(readStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Registry sync delayed")).toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(readStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("NUT")).toBeInTheDocument();
      expect(registryRead).toHaveBeenCalledTimes(2);

      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(readStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests sync on Refresh but not directory controls", async () => {
    vi.useFakeTimers();
    const config = { ...configuration(), registryEnabled: true };
    const registrySync = vi.fn().mockRejectedValue(new Error("offline"));
    try {
      render(
        <MemoryRouter>
          <TokensPage
            config={config}
            client={{} as never}
            scope="all"
            registryRead={vi.fn().mockResolvedValue(registryPage([]))}
            registryStatus={vi.fn().mockResolvedValue(registryStatus())}
            registrySync={registrySync}
            enrichBalances={vi.fn().mockResolvedValue([])}
          />
        </MemoryRouter>,
      );
      await act(async () => undefined);
      expect(registrySync).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByLabelText("Search tokens"), {
        target: { value: "Acorn" },
      });
      await act(async () => vi.advanceTimersByTimeAsync(300));
      fireEvent.change(screen.getByLabelText("Sort by"), {
        target: { value: "oldest" },
      });
      await act(async () => undefined);
      expect(registrySync).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await act(async () => undefined);
      expect(registrySync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function registryToken(): RegistryToken {
  const config = configuration();
  return {
    networkId: config.networkIdHex,
    factoryAddress: `0x${"03".repeat(32)}`,
    tokenAddress: `0x${"04".repeat(32)}`,
    creatorAddress: `0x${"02".repeat(32)}`,
    administratorAddress: `0x${"05".repeat(32)}`,
    initialHolderAddress: `0x${"06".repeat(32)}`,
    initialSupply: "12000000",
    name: "Acorn",
    symbol: "NUT",
    decimals: 7,
    tokenCodeHash: `0x${"00".repeat(32)}`,
    transactionHash: `0x${"07".repeat(32)}`,
    eventSequence: 0,
    blockHeight: "12",
    indexedAt: "2026-09-05T00:00:00.000Z",
  };
}

function registryPage(
  tokens: RegistryToken[],
  overrides: Partial<RegistryTokenPage> = {},
): RegistryTokenPage {
  return {
    tokens,
    total: tokens.length,
    limit: 20,
    offset: 0,
    asOfBlock: "12",
    hasMore: false,
    historyLimited: false,
    ...overrides,
  };
}

function registryStatus(): RegistryStatus {
  return {
    networkId: configuration().networkIdHex,
    factoryAddress: `0x${"03".repeat(32)}`,
    indexedThroughBlock: "12",
    tokenCount: 1,
    historyLimited: false,
    syncState: "idle",
    syncing: false,
    lastSuccessfulSyncAt: "2026-09-05T00:00:00.000Z",
    lastError: null,
  };
}

function saveWorkflowForTest(
  config: ReturnType<typeof configuration>,
  workflow: ReturnType<typeof createWorkflow>,
): void {
  saveWorkflow(window.localStorage, workflowStorageKey(config), workflow);
}

describe("launchpad navigation and hero", () => {
  it("orders the directory, wallet directory, and creation links", () => {
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }).querySelectorAll("a"),
    ).toHaveLength(3);
    expect(
      Array.from(
        screen
          .getByRole("navigation", { name: "Main navigation" })
          .querySelectorAll("a"),
        (link) => link.textContent,
      ),
    ).toEqual(["Tokens", "My Tokens", "Create Token"]);
  });

  it("keeps creation navigation available for disconnected users", () => {
    render(
      <MemoryRouter>
        <Header readOnly />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("link", { name: "Create Token" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Thruput Token Launchpad homepage" }),
    ).toHaveAttribute("href", "/tokens");
  });

  it.each(["/", "/create", "/my-tokens"])(
    "keeps disconnected route %s safe",
    async (initialEntry) => {
      render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <LaunchpadRoutes config={configuration()} readOnly />
          <RouteLocation />
        </MemoryRouter>,
      );
      expect(await screen.findByTestId("route-location")).toHaveTextContent(
        initialEntry === "/" ? "/tokens" : initialEntry,
      );
      expect(
        screen.queryByRole("link", { name: /create token/i }),
      ).toBeInTheDocument();
      if (initialEntry !== "/")
        expect(screen.getByText("Connect your wallet")).toBeInTheDocument();
    },
  );

  it("omits the registry empty-state create action in read-only mode", async () => {
    const config = { ...configuration(), registryEnabled: true };
    render(
      <MemoryRouter>
        <TokensPage
          config={config}
          client={{} as never}
          scope="all"
          readOnly
          registryRead={vi.fn().mockResolvedValue(registryPage([]))}
          registryStatus={vi.fn().mockResolvedValue(registryStatus())}
          registrySync={vi.fn().mockRejectedValue(new Error("offline"))}
          enrichBalances={vi.fn().mockResolvedValue([])}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /create token/i }),
    ).not.toBeInTheDocument();
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
        "Create a token on Thruput. Review the details, then launch.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Local network")).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Manual transaction processing" }),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Symbol")).toAppearBefore(
      screen.getByLabelText("Token name"),
    );
    expect(screen.getByText("SYMBOL")).toHaveAttribute(
      "data-slot",
      "card-title",
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.getAttribute("data-slot") === "card-description" &&
          element.textContent === "Your token · 7 decimals",
      ),
    ).toBeInTheDocument();
  });
});

function RouteLocation() {
  return <output data-testid="route-location">{useLocation().pathname}</output>;
}
