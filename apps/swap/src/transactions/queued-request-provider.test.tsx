// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  QueuedRequestProvider,
  useSharedQueuedRequest,
} from "./queued-request-provider";

let mounts = 0;
vi.mock("@/pools/use-pool", () => ({ useReader: () => ({ account: "account" }) }));
// Each mount of the tracker gets a new id, so the test can see a remount.
vi.mock("./use-queued-request", () => ({
  useQueuedRequest: () => useState(() => ({ id: ++mounts }))[0],
}));

function Page({ name, next }: { name: string; next: string }) {
  const request = useSharedQueuedRequest() as unknown as { id: number };
  return (
    <p>
      {name} tracker {request.id} <Link to={next}>go</Link>
    </p>
  );
}

afterEach(cleanup);

it("keeps one tracker when the user moves between pages", () => {
  render(
    <MemoryRouter initialEntries={["/pool"]}>
      <QueuedRequestProvider config={{ networkId: "net" } as never}>
        <Routes>
          <Route path="/pool" element={<Page name="Pool" next="/new" />} />
          <Route path="/new" element={<Page name="Create" next="/pool" />} />
        </Routes>
      </QueuedRequestProvider>
    </MemoryRouter>,
  );
  expect(screen.getByText(/Pool tracker 1/)).toBeTruthy();
  act(() => screen.getByRole("link", { name: "go" }).click());
  // The request a page was sending finishes into the same tracker.
  expect(screen.getByText(/Create tracker 1/)).toBeTruthy();
});
