import { describe, expect, test, vi } from "vitest";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { CELLS_CONTENT_TYPE } from "@/indexer/schema";
import {
  conwayOutcome,
  inspectExactCell,
  neighborhoodCoordinates,
  uniqueTileIndices,
} from "./exact-cell";

const snapshot = {
  manifest: {
    generation: "2",
    stateDigest: `0x${"dd".repeat(32)}`,
  },
  provenance: {
    sourceBlockHeight: "18",
    verifiedAt: "2026-08-30T21:16:28.327Z",
  },
} as ImmutableSnapshot;

describe("exact cell inspection", () => {
  test("wraps a corner neighborhood and deduplicates four exact tiles", () => {
    const coordinates = neighborhoodCoordinates(0, 0);
    expect(coordinates.map(({ x, y }) => [x, y])).toEqual([
      [9999, 9999],
      [0, 9999],
      [1, 9999],
      [9999, 0],
      [0, 0],
      [1, 0],
      [9999, 1],
      [0, 1],
      [1, 1],
    ]);
    expect(uniqueTileIndices(coordinates)).toEqual([
      { z: 6, x: 39, y: 39 },
      { z: 6, x: 0, y: 39 },
      { z: 6, x: 39, y: 0 },
      { z: 6, x: 0, y: 0 },
    ]);
  });

  test("loads one tile, decodes LSB-first cells, and derives a birth", async () => {
    const bytes = new Uint8Array(8_192);
    setCell(bytes, 9, 9, true);
    setCell(bytes, 10, 9, true);
    setCell(bytes, 11, 9, true);
    const tileUrl = vi.fn(() => new URL("http://127.0.0.1/tile.bin"));
    const fetcher = vi.fn(async () =>
      tileResponse(bytes, CELLS_CONTENT_TYPE),
    ) satisfies typeof fetch;
    const result = await inspectExactCell(
      { tileUrl } as unknown as IndexerClient,
      snapshot,
      10,
      10,
      new AbortController().signal,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.cells.map((cell) => cell.alive)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(result.liveNeighbors).toBe(3);
    expect(result.currentAlive).toBe(false);
    expect(result.nextAlive).toBe(true);
    expect(result.outcome).toBe("birth");
    expect(result.sourceBank).toBe("A");
    expect(result.destinationBank).toBe("B");
    expect(result.byteCells).toHaveLength(8);
  });

  test.each([
    [false, 3, "birth"],
    [false, 2, "remains-dead"],
    [true, 1, "loneliness"],
    [true, 2, "survival"],
    [true, 3, "survival"],
    [true, 4, "overcrowding"],
  ] as const)(
    "classifies current=%s neighbors=%i as %s",
    (current, neighbors, expected) => {
      expect(conwayOutcome(current, neighbors)).toBe(expected);
    },
  );

  test("rejects the wrong exact-cell media type", async () => {
    await expect(
      inspectExactCell(
        {
          tileUrl: () => new URL("http://127.0.0.1/tile.bin"),
        } as unknown as IndexerClient,
        snapshot,
        10,
        10,
        new AbortController().signal,
        vi.fn(async () =>
          tileResponse(new Uint8Array(8_192), "application/octet-stream"),
        ),
      ),
    ).rejects.toThrow(/content type/);
  });

  test("rejects an exact tile with the wrong decoded length", async () => {
    await expect(
      inspectExactCell(
        {
          tileUrl: () => new URL("http://127.0.0.1/tile.bin"),
        } as unknown as IndexerClient,
        snapshot,
        10,
        10,
        new AbortController().signal,
        vi.fn(async () =>
          tileResponse(new Uint8Array(8_191), CELLS_CONTENT_TYPE),
        ),
      ),
    ).rejects.toThrow(/content length/);
  });

  test("passes cancellation to every exact tile request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    ) as unknown as typeof fetch;
    const pending = inspectExactCell(
      {
        tileUrl: (
          _snapshot: ImmutableSnapshot,
          z: number,
          x: number,
          y: number,
        ) => new URL(`http://127.0.0.1/${z}/${x}/${y}.bin`),
      } as unknown as IndexerClient,
      snapshot,
      0,
      0,
      controller.signal,
      fetcher,
    );

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    controller.abort(new DOMException("Superseded", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

function setCell(bytes: Uint8Array, x: number, y: number, alive: boolean) {
  const offset = y * 32 + Math.floor(x / 8);
  const mask = 1 << (x % 8);
  bytes[offset] = alive ? bytes[offset]! | mask : bytes[offset]! & ~mask;
}

function tileResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  });
}
