/// <reference lib="webworker" />
import { decodeTile } from "./decode";

interface Request {
  readonly id: number;
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly z: number;
}
self.onmessage = ({ data }: MessageEvent<Request>) => {
  try {
    const tile = decodeTile(data.bytes, data.contentType, data.z);
    const transfers =
      tile.kind === "cells"
        ? [tile.packed.buffer, tile.values.buffer]
        : [tile.values.buffer];
    self.postMessage({ id: data.id, tile }, { transfer: transfers });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : "Tile decode failed",
    });
  }
};
