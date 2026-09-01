import type { GroundhogClient } from "@groundhogchain/client";
import { describe, expect, test, vi } from "vitest";
import { createLifeReadAdapter } from "./game-of-life";

const contract = `0x${"22".repeat(32)}`;

describe("typed Life event read adapter", () => {
  test("queries generated event filters from a bounded anchor", async () => {
    const getEvents = vi.fn(async () => page());
    const adapter = createLifeReadAdapter({
      client: { getEvents } as unknown as Pick<
        GroundhogClient,
        "view" | "getEvents"
      >,
      contractAddress: contract,
    });
    await expect(adapter.events(9n)).resolves.toEqual([]);
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: { height: 9n },
        limit: 200,
        order: "ascending",
      }),
    );
  });

  test("rejects repeated pagination cursors", async () => {
    const cursor = new Uint8Array([1]);
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(page(cursor))
      .mockResolvedValueOnce(page(cursor));
    const adapter = createLifeReadAdapter({
      client: { getEvents } as unknown as Pick<
        GroundhogClient,
        "view" | "getEvents"
      >,
      contractAddress: contract,
    });
    await expect(adapter.events(0n)).rejects.toThrow(/repeated cursor/);
  });
});

function page(cursor = new Uint8Array()) {
  return {
    cursor,
    events: [],
    latestBlock: 10n,
    oldestBlock: 0n,
  };
}
