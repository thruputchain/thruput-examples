// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { contractAddress } from "@thruputchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CreatePoll } from "./app";
import type { Transaction } from "./transactions/use-transaction";

vi.mock("@thruputchain/react", () => ({
  useWallet: () => ({ status: "connected" }),
}));
// The editor's own form is not under test: one button saves a fixed poll.
vi.mock("./components/poll-editor", () => ({
  PollEditor: ({ onSave }: { onSave: (definition: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onSave({ title: "T", description: "", questions: [{ title: "Q", options: ["A", "B"] }] })
      }
    >
      Save
    </button>
  ),
}));

const config = { address: contractAddress(new Uint8Array(32).fill(2)) } as never;

function renderPage(tx: Partial<Transaction>) {
  const transaction = {
    completed: null,
    blocked: false,
    send: vi.fn(async () => {}),
    dismissConfirmation: vi.fn(),
    ...tx,
  } as unknown as Transaction;
  const view = render(
    <StrictMode>
      <MemoryRouter initialEntries={["/create"]}>
        <Routes>
          <Route
            path="/create"
            element={<CreatePoll config={config} transaction={transaction} />}
          />
          <Route path="/admin" element={<p>Manage polls</p>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
  const rerender = (next: Partial<Transaction>) =>
    view.rerender(
      <StrictMode>
        <MemoryRouter initialEntries={["/create"]}>
          <Routes>
            <Route
              path="/create"
              element={
                <CreatePoll
                  config={config}
                  transaction={{ ...transaction, ...next } as Transaction}
                />
              }
            />
            <Route path="/admin" element={<p>Manage polls</p>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  return { transaction, rerender };
}

afterEach(cleanup);

it("clears a confirmation from an earlier visit without a redirect, also under StrictMode", () => {
  const { transaction } = renderPage({ completed: "Create poll" });
  expect(transaction.dismissConfirmation).toHaveBeenCalled();
  expect(screen.queryByText("Manage polls")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});

it("moves on to Manage polls when the poll sent from this page is confirmed", async () => {
  const { transaction, rerender } = renderPage({});
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(transaction.send).toHaveBeenCalledWith("Create poll", expect.anything());
  await act(async () => rerender({ completed: "Create poll" }));
  expect(screen.getByText("Manage polls")).toBeTruthy();
});
