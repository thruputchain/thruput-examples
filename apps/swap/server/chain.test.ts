// @vitest-environment node

import {
  addressFromHex,
  ContractDecodeError,
  ContractViewError,
  GroundhogRpcErrorCode,
  hashFromHex,
  JsonRpcError,
  type GroundhogClient,
} from "@groundhogchain/client";
import { networkHash } from "@groundhogchain/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SwapFactory, swap_if } from "../src/contracts/generated/swap-factory.ts";
import {
  GroundhogRegistrySource,
  RegistryCursorRejectedError,
  RegistryIntegrityError,
  RegistryScopeVerificationError,
} from "./chain.ts";
import type { RegistryScope } from "../shared/registry.ts";

const PoolCreated = swap_if.v0_1.events.PoolCreated;
type PoolCreated = swap_if.v0_1.events.PoolCreated;

const scope: RegistryScope = {
  networkId: "11".repeat(32),
  factoryAddress: addressHex(0x22),
};

afterEach(() => vi.restoreAllMocks());

describe("GroundhogRegistrySource", () => {
  it("uses the generated factory filter and maps verified PoolCreated evidence", async () => {
    const client = mockClient();
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    mockCoherentFactoryViews();
    client.getEvents.mockResolvedValue(
      eventPage({ cursor: Uint8Array.of(1, 2, 3) }),
    );
    const source = new GroundhogRegistrySource(typedClient(client), scope);

    const result = await source.getPage(request());

    expect(result).toMatchObject({
      nextCursor: "AQID",
      latestBlock: "12",
      oldestBlock: "1",
      pools: [
        {
          ...scope,
          token0Address: addressHex(1),
          token1Address: addressHex(2),
          liquidityTokenAddress: addressHex(3),
          handlerAddress: addressHex(4),
          driverAddress: addressHex(5),
          pairCount: "1",
          transactionHash: `0x${"88".repeat(32)}`,
          eventSequence: "7",
          createdBlock: "8",
        },
      ],
    });
    expect(client.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        order: "ascending",
        anchor: { height: 1n },
        limit: 20,
        filters: [
          expect.objectContaining({
            contractAddresses: [address(0x22)],
          }),
        ],
      }),
    );
    expect(SwapFactory.v0_1.pairAt.view).toHaveBeenCalledWith(
      expect.objectContaining({ args: { index: 0n } }),
    );
    expect(client.getNetworkInfo).toHaveBeenCalledTimes(2);
  });

  it("rejects endpoint drift before events and immediately before returning a page", async () => {
    const before = mockClient({ networkIds: [0x99] });
    await expect(
      new GroundhogRegistrySource(typedClient(before), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryScopeVerificationError);
    expect(before.getEvents).not.toHaveBeenCalled();

    const after = mockClient({ networkIds: [0x11, 0x99] });
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    mockCoherentFactoryViews();
    after.getEvents.mockResolvedValue(eventPage());
    await expect(
      new GroundhogRegistrySource(typedClient(after), scope).getPage(request()),
    ).rejects.toBeInstanceOf(RegistryScopeVerificationError);
  });

  it("leaves network transport failures transient", async () => {
    const client = mockClient();
    client.getNetworkInfo.mockRejectedValueOnce(new Error("temporary outage"));

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("temporary outage");
  });

  it("rejects non-factory emitters and malformed canonical pairs", async () => {
    const wrongEmitter = mockClient();
    wrongEmitter.getEvents.mockResolvedValue(
      eventPage({ event: identifiedEvent({ emitter: 0x23 }) }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(wrongEmitter), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);

    const unordered = mockClient();
    unordered.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(
      decoded({ token0: address(2), token1: address(1) }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(unordered), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it("requires positive pair counts and u32 event sequence numbers", async () => {
    const zeroCount = mockClient();
    zeroCount.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded({ pairCount: 0n }));
    await expect(
      new GroundhogRegistrySource(typedClient(zeroCount), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);

    vi.restoreAllMocks();
    const malformedCount = mockClient();
    malformedCount.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(
      decoded({ pairCount: 1 as unknown as bigint }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(malformedCount), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);

    const oversizedSequence = mockClient();
    oversizedSequence.getEvents.mockResolvedValue(
      eventPage({
        event: identifiedEvent({ sequenceNumber: 0x1_0000_0000 }),
      }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(oversizedSequence), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it("retries until all factory views share a height at or above the event", async () => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    vi.spyOn(SwapFactory.v0_1.getPair, "view")
      .mockResolvedValueOnce(view(address(4), 7n))
      .mockResolvedValueOnce(view(address(4), 9n));
    vi.spyOn(SwapFactory.v0_1.poolAddresses, "view")
      .mockResolvedValueOnce(view(pool(), 8n))
      .mockResolvedValueOnce(view(pool(), 9n));
    vi.spyOn(SwapFactory.v0_1.pairAt, "view")
      .mockResolvedValueOnce(view([address(1), address(2)] as const, 8n))
      .mockResolvedValueOnce(view([address(1), address(2)] as const, 9n));

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage(
        request(),
      ),
    ).resolves.toMatchObject({ pools: [{ handlerAddress: addressHex(4) }] });
    expect(SwapFactory.v0_1.getPair.view).toHaveBeenCalledTimes(2);
  });

  it("rejects contradictory state and exhausted incoherent reads", async () => {
    const contradictory = mockClient();
    contradictory.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    mockCoherentFactoryViews({ handler: address(9) });
    await expect(
      new GroundhogRegistrySource(typedClient(contradictory), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("contradicts live factory state");

    vi.restoreAllMocks();
    const incoherent = mockClient();
    incoherent.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    vi.spyOn(SwapFactory.v0_1.getPair, "view").mockResolvedValue(
      view(address(4), 7n),
    );
    vi.spyOn(SwapFactory.v0_1.poolAddresses, "view").mockResolvedValue(
      view(pool(), 8n),
    );
    vi.spyOn(SwapFactory.v0_1.pairAt, "view").mockResolvedValue(
      view([address(1), address(2)] as const, 8n),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(incoherent), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("one coherent block");
    expect(SwapFactory.v0_1.getPair.view).toHaveBeenCalledTimes(3);
  });

  it("classifies only invalid supplied cursors and preserves the abort signal", async () => {
    const client = mockClient();
    client.getEvents.mockRejectedValue(
      new JsonRpcError(GroundhogRpcErrorCode.InvalidParams, "invalid cursor"),
    );
    const signals: AbortSignal[] = [];
    const source = new GroundhogRegistrySource(
      typedClient(client),
      scope,
      (action, signal) => {
        signals.push(signal);
        return action();
      },
    );
    const signal = new AbortController().signal;
    await expect(
      source.getPage({ ...request(), cursor: "AQID", signal }),
    ).rejects.toBeInstanceOf(RegistryCursorRejectedError);
    expect(signals.every((seen) => seen === signal)).toBe(true);

    client.getEvents.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(
      source.getPage({ ...request(), cursor: null }),
    ).rejects.toThrow("temporary outage");
  });

  it("does not classify InvalidParams without a supplied cursor", async () => {
    const client = mockClient();
    const invalidParams = new JsonRpcError(
      GroundhogRpcErrorCode.InvalidParams,
      "invalid parameters",
    );
    client.getEvents.mockRejectedValue(invalidParams);

    const error = await new GroundhogRegistrySource(typedClient(client), scope)
      .getPage(request())
      .catch((caught: unknown) => caught);

    expect(error).toBe(invalidParams);
    expect(error).not.toBeInstanceOf(RegistryCursorRejectedError);
  });

  it("does not start RPC work for an already-aborted request", async () => {
    const client = mockClient();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("stopped");
    expect(client.getNetworkInfo).not.toHaveBeenCalled();
    expect(client.getEvents).not.toHaveBeenCalled();
  });

  it("bounds event pages and opaque cursors", async () => {
    const oversizedPage = mockClient();
    oversizedPage.getEvents.mockResolvedValue(
      eventPage({ events: [identifiedEvent(), identifiedEvent()] }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(oversizedPage), scope).getPage({
        ...request(),
        limit: 1,
      }),
    ).rejects.toThrow("oversized event page");

    const oversizedCursor = mockClient();
    oversizedCursor.getEvents.mockResolvedValue(
      eventPage({ events: [], cursor: new Uint8Array(3_073) }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(oversizedCursor), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("oversized event cursor");
  });

  it.each([
    ["negative latest block", { latestBlock: -1n, oldestBlock: 0n }],
    ["negative oldest block", { latestBlock: 12n, oldestBlock: -1n }],
    ["oldest block above latest", { latestBlock: 11n, oldestBlock: 12n }],
    [
      "non-bigint latest block",
      { latestBlock: 12 as unknown as bigint, oldestBlock: 1n },
    ],
  ])("rejects %s metadata as an integrity fault", async (_name, metadata) => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(eventPage({ ...metadata, events: [] }));

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it.each([
    ["below its requested anchor", 7n, "8"],
    ["above the page latest block", 13n, "1"],
    ["negative", -1n, "1"],
    ["not a bigint", 8 as unknown as bigint, "1"],
  ])("rejects an event block %s", async (_name, blockHeight, anchorBlock) => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(
      eventPage({ event: identifiedEvent({ blockHeight }) }),
    );

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage({
        ...request(),
        anchorBlock,
      }),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it("rejects descending event blocks and duplicate canonical identities", async () => {
    const descending = mockClient();
    descending.getEvents.mockResolvedValue(
      eventPage({
        events: [
          identifiedEvent({ blockHeight: 9n, txHashByte: 0x88 }),
          identifiedEvent({ blockHeight: 8n, txHashByte: 0x89 }),
        ],
      }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(descending), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("Malformed registry event page metadata");

    const duplicate = mockClient();
    const event = identifiedEvent();
    duplicate.getEvents.mockResolvedValue(
      eventPage({ events: [event, event] }),
    );
    await expect(
      new GroundhogRegistrySource(typedClient(duplicate), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("Malformed registry event page metadata");
  });

  it("rejects events below the page oldest block", async () => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(
      eventPage({
        event: identifiedEvent({ blockHeight: 7n }),
        oldestBlock: 8n,
      }),
    );

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage(
        request(),
      ),
    ).rejects.toBeInstanceOf(RegistryIntegrityError);
  });

  it("rejects duplicate or descending factory pair evidence", async () => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(
      eventPage({
        events: [
          identifiedEvent({ txHashByte: 0x88 }),
          identifiedEvent({ txHashByte: 0x89, sequenceNumber: 8 }),
        ],
      }),
    );
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded({ pairCount: 1n }));
    mockCoherentFactoryViews();

    await expect(
      new GroundhogRegistrySource(typedClient(client), scope).getPage(
        request(),
      ),
    ).rejects.toThrow("duplicated or out of order");
  });

  it.each([
    new ContractDecodeError("malformed view return"),
    new ContractViewError({ kind: "fault", height: 8n, events: [] }),
  ])(
    "classifies generated factory failure $name as integrity",
    async (error) => {
      const client = mockClient();
      client.getEvents.mockResolvedValue(eventPage());
      vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
      mockCoherentFactoryViews();
      vi.mocked(SwapFactory.v0_1.getPair.view).mockRejectedValue(error);

      const caught = await new GroundhogRegistrySource(
        typedClient(client),
        scope,
      )
        .getPage(request())
        .catch((value: unknown) => value);

      expect(caught).toBeInstanceOf(RegistryIntegrityError);
      expect((caught as Error & { cause?: unknown }).cause).toBe(error);
    },
  );

  it("leaves generic factory view failures transient", async () => {
    const client = mockClient();
    client.getEvents.mockResolvedValue(eventPage());
    vi.spyOn(PoolCreated, "decode").mockReturnValue(decoded());
    mockCoherentFactoryViews();
    const transportFailure = new Error("transport unavailable");
    vi.mocked(SwapFactory.v0_1.getPair.view).mockRejectedValue(transportFailure);

    const caught = await new GroundhogRegistrySource(typedClient(client), scope)
      .getPage(request())
      .catch((value: unknown) => value);

    expect(caught).toBe(transportFailure);
    expect(caught).not.toBeInstanceOf(RegistryIntegrityError);
  });
});

function mockClient(options: { networkIds?: number[] } = {}) {
  const networkIds = options.networkIds ?? [0x11];
  return {
    view: vi.fn(),
    getEvents: vi.fn(),
    getNetworkInfo: vi.fn(async () => ({
      networkHash: networkHash(
        hashFromHex(`0x${byteHex(networkIds.shift() ?? 0x11)}`),
      ),
    })),
  };
}

function typedClient(client: ReturnType<typeof mockClient>) {
  return client as unknown as Pick<
    GroundhogClient,
    "getEvents" | "getNetworkInfo" | "view"
  >;
}

function request() {
  return {
    anchorBlock: "1",
    cursor: null,
    limit: 20,
    signal: new AbortController().signal,
  };
}

function decoded(
  overrides: {
    token0?: ReturnType<typeof address>;
    token1?: ReturnType<typeof address>;
    pairCount?: bigint;
  } = {},
) {
  return {
    name: "PoolCreated" as const,
    topics: {
      token0: overrides.token0 ?? address(1),
      token1: overrides.token1 ?? address(2),
    },
    fields: {
      liquidity_token: address(3),
      handler: address(4),
      driver: address(5),
      pair_count: overrides.pairCount ?? 1n,
    },
  };
}

function mockCoherentFactoryViews(
  overrides: { handler?: ReturnType<typeof address> } = {},
) {
  vi.spyOn(SwapFactory.v0_1.getPair, "view").mockResolvedValue(
    view(overrides.handler ?? address(4), 8n),
  );
  vi.spyOn(SwapFactory.v0_1.poolAddresses, "view").mockResolvedValue(
    view(pool(), 8n),
  );
  vi.spyOn(SwapFactory.v0_1.pairAt, "view").mockResolvedValue(
    view([address(1), address(2)] as const, 8n),
  );
}

function pool() {
  return {
    liquidity_token: address(3),
    handler: address(4),
    driver: address(5),
  };
}

function view<T>(value: T, height: bigint) {
  return { value, height, events: [] };
}

function eventPage(
  overrides: {
    event?: ReturnType<typeof identifiedEvent>;
    events?: ReturnType<typeof identifiedEvent>[];
    cursor?: Uint8Array;
    latestBlock?: bigint;
    oldestBlock?: bigint;
  } = {},
) {
  return {
    events: overrides.events ?? [overrides.event ?? identifiedEvent()],
    cursor: overrides.cursor ?? new Uint8Array(),
    latestBlock: overrides.latestBlock ?? 12n,
    oldestBlock: overrides.oldestBlock ?? 1n,
  };
}

function identifiedEvent(
  overrides: {
    emitter?: number;
    sequenceNumber?: number;
    blockHeight?: bigint;
    txHashByte?: number;
  } = {},
) {
  return {
    txHash: hashFromHex(
      `0x${(overrides.txHashByte ?? 0x88).toString(16).padStart(2, "0").repeat(32)}`,
    ),
    blockHeight: overrides.blockHeight ?? 8n,
    sequenceNumber: overrides.sequenceNumber ?? 7,
    event: {
      contractAddress: address(overrides.emitter ?? 0x22),
      topics: [],
      data: new Uint8Array(),
    },
  };
}

function address(byte: number) {
  return addressFromHex(addressHex(byte));
}

function addressHex(byte: number) {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function byteHex(byte: number) {
  return byte.toString(16).padStart(2, "0").repeat(32);
}
