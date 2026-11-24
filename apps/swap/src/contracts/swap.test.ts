import { fixedBytes } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { ERC20Metadata } from "@/contracts/generated/erc20";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { swap_if } from "@/contracts/generated/swap-handler";
import { findRequestOutcome, readPoolPage, readToken, sortTokens } from "./swap";

const address = (byte: number) => contractAddress(new Uint8Array(32).fill(byte));
const pool = { driver: address(1), handler: address(2) };
const ours = fixedBytes(new Uint8Array(32).fill(7), 32);
const other = fixedBytes(new Uint8Array(32).fill(8), 32);

/** A client whose event walk returns one page of fake events. */
function client(events: { kind: string; requestId?: typeof ours }[]) {
  const iterateEventPages = vi.fn(async function* () {
    yield { events: events.map((event) => ({ event })) };
  });
  return { iterateEventPages } as never;
}

function decodeAs(
  definition: object,
  kind: string,
  fields: (event: { requestId?: unknown }) => unknown,
) {
  vi.spyOn(definition as { decode: (event: unknown) => unknown }, "decode").mockImplementation(((event: {
    kind: string;
    requestId?: unknown;
  }) => (event.kind === kind ? { fields: fields(event) } : null)) as never);
}

afterEach(() => vi.restoreAllMocks());

function stubEvents() {
  decodeAs(batch_driver.v0_1.events.RequestFailed, "failed", () => ({}));
  decodeAs(swap_if.v0_1.events.SwapEvent, "swap", (event) => ({
    request_id: event.requestId,
    amounts_out: [0n, 42n],
  }));
  decodeAs(swap_if.v0_1.events.LiquidityMintEvent, "mint", () => null);
  decodeAs(swap_if.v0_1.events.LiquidityBurnEvent, "burn", () => null);
}

it("matches the swap event that carries the request ID", async () => {
  stubEvents();
  const outcome = await findRequestOutcome(
    client([
      { kind: "swap", requestId: other },
      { kind: "swap", requestId: ours },
    ]),
    pool,
    ours,
    address(3),
    5n,
  );
  expect(outcome).toEqual({ status: "done", amounts: [0n, 42n] });
});

it("reports a failed request, and a request that is still queued", async () => {
  stubEvents();
  expect(
    await findRequestOutcome(client([{ kind: "failed" }]), pool, ours, address(3), 5n),
  ).toEqual({ status: "failed" });
  expect(
    await findRequestOutcome(
      client([{ kind: "swap", requestId: other }]),
      pool,
      ours,
      address(3),
      5n,
    ),
  ).toBeNull();
});

it("orders a pair's tokens by address bytes", () => {
  expect(sortTokens(address(9), address(1))).toEqual([address(1), address(9)]);
  expect(() => sortTokens(address(1), address(1))).toThrow();
});

it("rejects a token whose decimals this app cannot format", async () => {
  const metadata = ERC20Metadata.v0_1;
  vi.spyOn(metadata.name, "view").mockResolvedValue({ value: "Wide" } as never);
  vi.spyOn(metadata.symbol, "view").mockResolvedValue({ value: "WIDE" } as never);
  const decimals = vi.spyOn(metadata.decimals, "view");
  const reader = { client: {}, factory: address(4), caller: address(5) } as never;

  decimals.mockResolvedValue({ value: 255n } as never);
  expect((await readToken(reader, address(6))).decimals).toBe(255);
  // The factory accepts any u32; amounts here format at most 255 decimals.
  decimals.mockResolvedValue({ value: 300n } as never);
  await expect(readToken(reader, address(6))).rejects.toThrow(
    /WIDE declares 300 decimals; this app supports at most 255/,
  );
});

it("reads missing decimals as the fallback, as for a pool's LP token", async () => {
  const metadata = ERC20Metadata.v0_1;
  vi.spyOn(metadata.name, "view").mockResolvedValue({ value: null } as never);
  vi.spyOn(metadata.symbol, "view").mockResolvedValue({ value: null } as never);
  vi.spyOn(metadata.decimals, "view").mockResolvedValue({ value: null } as never);
  const reader = { client: {}, factory: address(4), caller: address(5) } as never;
  expect((await readToken(reader, address(6))).decimals).toBe(0);
  expect((await readToken(reader, address(6), 6)).decimals).toBe(6);
});

it("counts an older page from the total the first page saw", async () => {
  // The factory now has 30 pools; the visitor's first page saw 25.
  const length = vi.spyOn(SwapFactory.v0_1.allPairsLength, "view").mockResolvedValue({ value: 30n } as never);
  const readViews = vi.fn(async ({ calls }: { calls: unknown[] }) => ({
    results: calls.map(() => ({ kind: "return", value: [address(1), address(2)] })),
  }));
  const reader = { client: { readViews }, factory: address(4), caller: address(5) } as never;
  const pairAt = vi.spyOn(SwapFactory.v0_1.pairAt, "viewRequest");
  const page = await readPoolPage(reader, 1, 25n);
  expect(length).not.toHaveBeenCalled();
  expect(page.total).toBe(25n);
  // 12 per page, counted from 25: the second page is pairs 12 down to 1.
  // Counted from 30, it would start at 17 and repeat the first page's last pool.
  const indexes = pairAt.mock.calls.map(([request]) => (request as { args: { index: bigint } }).args.index);
  expect(indexes).toEqual(Array.from({ length: 12 }, (_, i) => 12n - BigInt(i)));
});
