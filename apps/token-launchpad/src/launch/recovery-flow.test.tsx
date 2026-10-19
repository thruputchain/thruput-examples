import { fixedBytes, toBase58 } from "@thruputchain/client";
import { AppProviders } from "@/app-providers";
import { testClient } from "@/test/wallet";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { reviewFactory } from "@/contracts/launchpad-client";
import { configuration } from "@/test/fixtures";
import type { WriteResult } from "@/transactions/write-boundary";
import { CreatePage } from "./create-page";
import {
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  workflowStorageKey,
} from "./workflow";

vi.mock("@/contracts/launchpad-client", () => ({ reviewFactory: vi.fn() }));
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const config = configuration();
const client = {} as never;
const hash = toBase58(new Uint8Array(32).fill(0x06));
function setup(funded = false) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, action: () => unknown) => action() },
  });
  const review = {
    config: {
      native_token: config.nativeHogAddress,
      token_code_hash: fixedBytes(config.expectedTokenHash, 32),
      required_token_funding: 100n,
      creation_fee: 0n,
      fee_recipient: null,
    },
    predictedAddress: config.factoryAddress,
    currentReserve: funded ? 100n : 0n,
    reserveHeight: 0n,
    fundingAmount: funded ? 0n : 110n,
    creatorBalance: 1000n,
    fundingShortfall: 0n,
  };
  vi.mocked(reviewFactory).mockResolvedValue(review);
  const workflow = createWorkflow(
    config,
    { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
    new Uint8Array(32).fill(5),
    review,
  );
  if (funded) workflow.funding = { status: "committed", hash };
  saveWorkflow(localStorage, workflowStorageKey(config), workflow);
  const execute = vi.fn().mockResolvedValue({
    kind: "preSubmissionFailure",
    hash: null,
    message:
      "Wallet approval timed out. Try again to open a new request. Your token details are saved.",
  });
  const writer = { execute, observe: vi.fn() };
  const page = (connected = true) => (
    <MemoryRouter>
      <CreatePage
        config={config}
        client={client}
        writer={writer}
        connected={connected}
      />
    </MemoryRouter>
  );
  return { workflow, writer, page };
}

it.each([false, true])(
  "retries an approval timeout with committed funding=%s without replacing the launch",
  async (funded) => {
    const { workflow, writer, page } = setup(funded);
    render(page());
    fireEvent.click(
      screen.getByRole("button", {
        name: funded ? "Create token" : "Launch token",
      }),
    );
    expect(await screen.findByText(/Wallet approval timed out/)).toBeVisible();
    const retry = screen.getByRole("button", {
      name: funded ? "Retry creation" : "Retry funding",
    });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retry).toBeEnabled());
    const stored = loadWorkflow(localStorage, workflowStorageKey(config))!;
    expect(stored.id).toBe(workflow.id);
    expect(stored.nonceHex).toBe(workflow.nonceHex);
    expect(stored.token).toEqual(workflow.token);
    expect(stored.funding).toEqual(workflow.funding);
    for (const [invocation] of writer.execute.mock.calls)
      expect(invocation.invocation.invoked_address).toEqual(
        funded ? config.factoryAddress : config.nativeHogAddress,
      );
    expect(writer.observe).not.toHaveBeenCalled();
  },
);

it("offers completed launch actions above the form and in the review, and resets from the top", async () => {
  const { workflow, writer } = setup(true);
  workflow.creation = { status: "committed", hash };
  workflow.createdAddress = workflow.predictedAddress;
  workflow.creationBlock = "1";
  workflow.verification = {
    status: "complete",
    message: null,
    totalSupply: "12",
    holderBalance: "12",
  };
  saveWorkflow(localStorage, workflowStorageKey(config), workflow);
  render(
    <MemoryRouter>
      <CreatePage
        config={{ ...config, swapAppUrl: "https://swap.example.com" }}
        client={client}
        writer={writer}
      />
    </MemoryRouter>,
  );
  const actions = screen.getAllByRole("group", {
    name: "Token creation actions",
  });
  expect(actions).toHaveLength(2);
  expect(
    actions[0]!.compareDocumentPosition(screen.getByLabelText("Token name")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const group of actions) {
    expect(
      within(group).getByRole("button", { name: "Create another token" }),
    ).toBeEnabled();
    expect(
      within(group).getByRole("link", { name: "View my tokens" }),
    ).toHaveAttribute("href", "/my-tokens");
    expect(
      within(group).getByRole("link", { name: "Create AMM Pool" }),
    ).toHaveAttribute(
      "href",
      `https://swap.example.com/pools/new?tokenA=${workflow.createdAddress}`,
    );
  }
  fireEvent.click(
    within(actions[0]!).getByRole("button", { name: "Create another token" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Token name")).toBeEnabled(),
  );
  expect(screen.getByLabelText("Token name")).toHaveValue("");
  expect(
    screen.queryByRole("group", { name: "Token creation actions" }),
  ).toBeNull();
  expect(writer.execute).not.toHaveBeenCalled();
});

it("keeps token details when editing after timeout", async () => {
  const { page } = setup();
  render(page());
  fireEvent.click(screen.getByRole("button", { name: "Launch token" }));
  await screen.findByText(/Wallet approval timed out/);
  fireEvent.click(screen.getByRole("button", { name: "Edit token details" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Token name")).toBeEnabled(),
  );
  expect(screen.getByLabelText("Token name")).toHaveValue("Acorn");
  expect(screen.getByLabelText("Symbol")).toHaveValue("NUT");
  expect(localStorage.getItem(workflowStorageKey(config))).toBeNull();
});

it("starts over only before funding and clears the token form", async () => {
  const { page } = setup();
  const view = render(page());
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Token name")).toBeEnabled(),
  );
  expect(screen.getByLabelText("Token name")).toHaveValue("");
  expect(screen.getByLabelText("Symbol")).toHaveValue("");
  expect(localStorage.getItem(workflowStorageKey(config))).toBeNull();
  view.unmount();
  const funded = setup(true);
  render(funded.page());
  expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Edit token details" }),
  ).toBeNull();
});

it("preserves an in-flight launch through disconnect and permits retry after reconnect", async () => {
  const publicClient = await testClient(config.networkId);
  const { workflow, writer, page } = setup();
  let resolve!: (result: WriteResult) => void;
  writer.execute.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(page(), {
    wrapper: ({ children }) => (
      <AppProviders client={publicClient} explorerUrl={config.explorerUrl}>
        {children}
      </AppProviders>
    ),
  });
  fireEvent.click(screen.getByRole("button", { name: "Launch token" }));
  await waitFor(() => expect(writer.execute).toHaveBeenCalledOnce());
  view.rerender(page(false));
  expect(
    screen.getByText("Reconnect to continue", {
      selector: '[data-slot="alert-title"]',
    }),
  ).toBeVisible();
  expect(screen.getByLabelText("Token name")).toHaveValue("Acorn");
  await act(async () =>
    resolve({
      kind: "preSubmissionFailure",
      hash: null,
      message:
        "Reconnect your wallet to continue this launch. Your progress is saved.",
    }),
  );
  view.rerender(page());
  expect(screen.getByText("Wallet reconnected")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry funding" }));
  await waitFor(() => expect(writer.execute).toHaveBeenCalledTimes(2));
  expect(loadWorkflow(localStorage, workflowStorageKey(config))?.id).toBe(
    workflow.id,
  );
  await screen.findByText(/Wallet approval timed out/);
});
