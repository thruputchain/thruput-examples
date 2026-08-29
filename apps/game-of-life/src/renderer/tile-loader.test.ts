import { describe, expect, test, vi } from "vitest";
import { CELLS_CONTENT_TYPE } from "@/indexer/schema";
import { TileLoader } from "./tile-loader";

const digest = `0x${"aa".repeat(32)}`;
const index = { z: 6, x: 0, y: 0 };

function setup(fetcher: typeof fetch) {
  const pool = {
    decode: vi.fn(async (bytes: ArrayBuffer) => ({
      kind: "cells" as const,
      packed: new Uint8Array(bytes),
      values: new Uint8Array(65_536),
    })),
    close: vi.fn(),
  };
  const loader = new TileLoader(
    { tileUrl: () => new URL("http://127.0.0.1/tile.bin") } as never,
    { manifest: { stateDigest: digest } } as never,
    pool as never,
    fetcher,
  );
  return { loader, pool };
}

describe("tile loader", () => {
  test("accepts a genuine multi-chunk body without Content-Length", async () => {
    const fetcher = vi.fn(async () =>
      chunkedResponse([new Uint8Array(3000), new Uint8Array(5192)], {
        headers: { "content-type": CELLS_CONTENT_TYPE },
      }),
    );
    const { loader, pool } = setup(fetcher as typeof fetch);
    await expect(loader.load(index)).resolves.toMatchObject({ index });
    expect(pool.decode).toHaveBeenCalledOnce();
    loader.close();
  });

  test("treats decoded bytes as authoritative for encoded responses", async () => {
    const fetcher = vi.fn(async () =>
      chunkedResponse([new Uint8Array(4096), new Uint8Array(4096)], {
        headers: {
          "content-type": CELLS_CONTENT_TYPE,
          "content-encoding": "gzip",
          "content-length": "127",
        },
      }),
    );
    const { loader } = setup(fetcher as typeof fetch);
    await expect(loader.load(index)).resolves.toMatchObject({ index });
    loader.close();
  });

  test("pre-rejects an unencoded declared length mismatch", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(8192), {
          headers: {
            "content-type": CELLS_CONTENT_TYPE,
            "content-length": "127",
          },
        }),
    );
    const { loader, pool } = setup(fetcher as typeof fetch);
    await expect(loader.load(index)).rejects.toThrow(/content length/);
    expect(pool.decode).not.toHaveBeenCalled();
    loader.close();
  });

  test("decodes prefetch into cache and visible load does not refetch", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(8192), {
          headers: { "content-type": CELLS_CONTENT_TYPE },
        }),
    );
    const { loader, pool } = setup(fetcher as typeof fetch);
    await loader.prefetch([index], new AbortController().signal);
    expect(loader.cache.get(`${digest}:6/0/0`)).toMatchObject({ index });
    await expect(loader.load(index)).resolves.toMatchObject({ index });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(pool.decode).toHaveBeenCalledOnce();
    loader.close();
  });

  test("obsolete prefetch aborts without duplicating a joined visible load", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
      ]);
      return new Response(new Uint8Array(8192), {
        headers: { "content-type": CELLS_CONTENT_TYPE },
      });
    });
    const { loader } = setup(fetcher as typeof fetch);
    const prefetchController = new AbortController();
    const prefetch = loader.prefetch([index], prefetchController.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const visible = loader.load(index, new AbortController().signal);
    prefetchController.abort();
    await expect(prefetch).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    release();
    await expect(visible).resolves.toMatchObject({ index });
    loader.close();
  });

  test("aborts obsolete prefetch with no visible consumer", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal as AbortSignal;
          upstreamSignal.addEventListener("abort", () =>
            reject(upstreamSignal?.reason),
          );
        }),
    );
    const { loader } = setup(fetcher as typeof fetch);
    const controller = new AbortController();
    const prefetch = loader.prefetch([index], controller.signal);
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort();
    await expect(prefetch).rejects.toBeDefined();
    expect(upstreamSignal?.aborted).toBe(true);
    loader.close();
  });

  test("lets one deduplicated consumer abort without canceling another", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_input, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      await pending;
      return new Response(new Uint8Array(8192), {
        headers: { "content-type": CELLS_CONTENT_TYPE },
      });
    });
    const { loader } = setup(fetcher as typeof fetch);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = loader.load(index, firstController.signal);
    const second = loader.load(index, secondController.signal);
    firstController.abort();
    await expect(first).rejects.toBeDefined();
    expect(upstreamSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ index });
    expect(fetcher).toHaveBeenCalledOnce();
    loader.close();
  });

  test("aborts shared work after its final consumer leaves", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal as AbortSignal;
          upstreamSignal.addEventListener("abort", () =>
            reject(upstreamSignal?.reason),
          );
        }),
    );
    const { loader } = setup(fetcher as typeof fetch);
    const controller = new AbortController();
    const result = loader.load(index, controller.signal);
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(upstreamSignal?.aborted).toBe(true);
    loader.close();
  });

  test("rejects decoded bodies with the wrong authoritative length", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(8191), {
          headers: { "content-type": CELLS_CONTENT_TYPE },
        }),
    );
    const { loader } = setup(fetcher as typeof fetch);
    await expect(loader.load(index)).rejects.toThrow(/decoded tile length/);
    loader.close();
  });
});

function chunkedResponse(
  chunks: readonly Uint8Array[],
  init: ResponseInit,
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
    init,
  );
}
