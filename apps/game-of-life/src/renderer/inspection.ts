import { MAX_ZOOM, TILE_SIZE, WORLD_SIZE } from "@/indexer/schema";
import { cellsPerTexel, worldToTile } from "./pyramid";

export type DecodedTile =
  | { readonly kind: "density"; readonly values: Uint16Array }
  | {
      readonly kind: "cells";
      readonly packed: Uint8Array;
      readonly values: Uint8Array;
    };
export type Inspection =
  | {
      readonly kind: "density";
      readonly generation: string;
      readonly x: number;
      readonly y: number;
      readonly live: number;
      readonly covered: number;
    }
  | {
      readonly kind: "cell";
      readonly generation: string;
      readonly x: number;
      readonly y: number;
      readonly alive: boolean;
    };
export function inspect(
  tile: DecodedTile,
  x: number,
  y: number,
  z: number,
  generation: string,
): Inspection {
  const mapped = worldToTile(x, y, z);
  if (tile.kind === "cells") {
    if (z !== MAX_ZOOM) throw new Error("cell tile used below exact zoom");
    const byte =
      tile.packed[mapped.localY * 32 + Math.floor(mapped.localX / 8)] ?? 0;
    return {
      kind: "cell",
      generation,
      x: Math.floor(x),
      y: Math.floor(y),
      alive: ((byte >> (mapped.localX % 8)) & 1) === 1,
    };
  }
  const scale = cellsPerTexel(z);
  const originX = mapped.tile.x * TILE_SIZE * scale + mapped.texelX * scale;
  const originY = mapped.tile.y * TILE_SIZE * scale + mapped.texelY * scale;
  const covered =
    Math.max(0, Math.min(scale, WORLD_SIZE - originX)) *
    Math.max(0, Math.min(scale, WORLD_SIZE - originY));
  return {
    kind: "density",
    generation,
    x: Math.floor(x),
    y: Math.floor(y),
    live: tile.values[mapped.texelY * TILE_SIZE + mapped.texelX] ?? 0,
    covered,
  };
}
