// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CreatePoolPage } from "./create-pool-page";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const [tokenA, tokenB] = [address(1), address(2)];
const pool = { driver: address(7), handler: address(8), liquidityToken: address(9) };
const mocks = vi.hoisted(() => ({ request: {} as Record<string, unknown> }));

vi.mock("@/transactions/queued-request-provider", () => ({
  useSharedQueuedRequest: () => mocks.request,
}));
vi.mock("./use-pool", () => ({ useReader: () => ({ reader: {}, account: address(5) }) }));
vi.mock("./request-status", () => ({ RequestStatus: () => null }));
// Token search is not under test: the fields are plain inputs.
vi.mock("./token-field", () => ({
  TokenField: (props: { id: string; value: string; onChange: (value: string) => void }) => (
    <input id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
  ),
}));
vi.mock("@/contracts/swap", async (original) => ({
  ...(await original<typeof import("@/contracts/swap")>()),
  readPool: async () => null,
  readToken: async (_reader: unknown, token: ReturnType<typeof address>) => ({
    address: token,
    name: "Token",
    symbol: token[0] === 1 ? "AAA" : "BBB",
    decimals: 0,
  }),
  readPoolAddresses: async () => pool,
  readPoolFunding: async () => 1n,
  readBalance: async () => 1_000_000_000n,
}));

afterEach(cleanup);

function renderPage() {
  mocks.request = { busy: false, finished: null, submit: vi.fn() };
  const view = render(
    <MemoryRouter
      initialEntries={[`/pools/new?tokenA=${toBase58(tokenA)}&tokenB=${toBase58(tokenB)}`]}
    >
      <CreatePoolPage config={{ nativeTokenAddress: address(3) } as never} />
    </MemoryRouter>,
  );
  return () =>
    view.rerender(
      <MemoryRouter
        initialEntries={[`/pools/new?tokenA=${toBase58(tokenA)}&tokenB=${toBase58(tokenB)}`]}
      >
        <CreatePoolPage config={{ nativeTokenAddress: address(3) } as never} />
      </MemoryRouter>,
    );
}

it("keeps linking to a created pool after its failed deposit is dismissed", async () => {
  const rerender = renderPage();
  fireEvent.change(screen.getByLabelText("Token A amount"), { target: { value: "50000" } });
  fireEvent.change(screen.getByLabelText("Token B amount"), { target: { value: "50000" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Review pool" })));
  expect(screen.getByRole("button", { name: "Create pool" })).toBeTruthy();

  // The pair was created; the first deposit failed at the crank.
  mocks.request.finished = {
    label: "Create AAA / BBB",
    driver: toBase58(pool.driver),
    outcome: { status: "failed" },
  };
  act(() => rerender());
  expect(screen.getByRole("link", { name: "Open the pool" })).toBeTruthy();
  expect(screen.getByText(/The pool exists/)).toBeTruthy();

  // The user dismisses the result: the pool still exists.
  mocks.request.finished = null;
  act(() => rerender());
  expect(screen.getByRole("link", { name: "Open the pool" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create pool" })).toBeNull();
});
