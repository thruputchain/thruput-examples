import { fixedBytes } from "@groundhogchain/client";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { FactoryReview } from "@/contracts/launchpad-client";
import * as factory from "@/contracts/launchpad-client";
import { configuration } from "@/test/fixtures";
import { runWorkflow } from "./executor";
import { createWorkflow, saveWorkflow, workflowStorageKey } from "./workflow";
import { CreatePage } from "./create-page";

vi.mock("./executor", () => ({ runWorkflow: vi.fn() }));
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
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
    creatorBalance: 1000n,
    fundingShortfall: 0n,
  };
}

it("checks recovered funding without creating a token until the next explicit action", async () => {
  const config = configuration();
  const workflow = {
    ...createWorkflow(
      config,
      { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
      new Uint8Array(32).fill(5),
      reviewed(),
    ),
    funding: { status: "uncertain" as const, hash: `0x${"06".repeat(32)}` },
  };
  const recovered = {
    ...workflow,
    revision: 1,
    funding: { ...workflow.funding, status: "committed" as const },
  };
  saveWorkflow(localStorage, workflowStorageKey(config), workflow);
  const run = vi.mocked(runWorkflow).mockResolvedValue(recovered);
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <CreatePage
        config={config}
        client={{} as never}
        writer={{ execute: vi.fn(), observe: vi.fn() }}
      />
    </MemoryRouter>,
  );
  await user.click(
    screen.getByRole("button", { name: "Check funding transaction" }),
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].automatic).toBe(false);
  await user.click(screen.getByRole("button", { name: "Create token" }));
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    automatic: false,
    workflowRevision: 1,
  });
});

it("blocks invalid token inputs before factory reads or signing", () => {
  const review = vi.spyOn(factory, "reviewFactory");
  const execute = vi.fn();
  render(
    <MemoryRouter>
      <CreatePage
        config={configuration()}
        client={{} as never}
        writer={{ execute, observe: vi.fn() }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
  expect(screen.getByText("Check the token details")).toBeVisible();
  expect(review).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it("does not save a review that finishes after the page unmounts", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, action: () => unknown) => action(),
    },
  });
  let resolve!: (value: FactoryReview) => void;
  vi.spyOn(factory, "reviewFactory").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const config = configuration();
  const view = render(
    <MemoryRouter>
      <CreatePage
        config={config}
        client={{} as never}
        writer={{ execute: vi.fn(), observe: vi.fn() }}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Symbol"), {
    target: { value: "NUT" },
  });
  fireEvent.change(screen.getByLabelText("Token name"), {
    target: { value: "Acorn" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
  await waitFor(() => expect(factory.reviewFactory).toHaveBeenCalled());
  view.unmount();
  await act(async () => resolve(reviewed()));
  expect(localStorage.getItem(workflowStorageKey(config))).toBeNull();
});
