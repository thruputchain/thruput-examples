import {
  CELLS_CONTENT_TYPE,
  DENSITY_CONTENT_TYPE,
  MAX_ZOOM,
  TILE_SIZE,
} from "@/indexer/schema";
import type { DecodedTile } from "./inspection";

export const DENSITY_BYTES = TILE_SIZE * TILE_SIZE * 2;
export const CELL_BYTES = TILE_SIZE * 32;
export function decodeTile(
  bytes: ArrayBuffer,
  contentType: string,
  z: number,
): DecodedTile {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM)
    throw new Error("invalid tile zoom");
  if (z === MAX_ZOOM) {
    if (contentType !== CELLS_CONTENT_TYPE || bytes.byteLength !== CELL_BYTES)
      throw new Error("invalid exact-cell tile response");
    const packed = new Uint8Array(bytes);
    const values = new Uint8Array(TILE_SIZE * TILE_SIZE);
    for (let y = 0; y < TILE_SIZE; y += 1)
      for (let x = 0; x < TILE_SIZE; x += 1)
        values[y * TILE_SIZE + x] =
          (packed[y * 32 + Math.floor(x / 8)]! >> (x % 8)) & 1;
    return { kind: "cells", packed, values };
  }
  if (
    contentType !== DENSITY_CONTENT_TYPE ||
    bytes.byteLength !== DENSITY_BYTES
  )
    throw new Error("invalid density tile response");
  const view = new DataView(bytes);
  const values = new Uint16Array(TILE_SIZE * TILE_SIZE);
  const cellsPerTexel = 2 ** (MAX_ZOOM - z);
  const maximumDensity = cellsPerTexel * cellsPerTexel;
  for (let index = 0; index < values.length; index += 1) {
    const value = view.getUint16(index * 2, true);
    if (value > maximumDensity)
      throw new Error("invalid density tile response");
    values[index] = value;
  }
  return { kind: "density", values };
}
