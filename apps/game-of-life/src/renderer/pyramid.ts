import { MAX_ZOOM, TILE_SIZE, WORLD_SIZE } from "@/indexer/schema";

export interface TileIndex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface TileBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export interface RefinementTile {
  index: TileIndex;
  isSelected: boolean;
  isLoaded: boolean;
  content: { digest: string } | null;
  isVisible: boolean;
}

export const cellsPerTexel = (z: number): number => 2 ** (MAX_ZOOM - z);
export const tileSpan = (z: number): number => TILE_SIZE * cellsPerTexel(z);
export const tileCount = (z: number): number =>
  Math.ceil(WORLD_SIZE / tileSpan(z));
export const tileId = ({ z, x, y }: TileIndex): string => `${z}/${x}/${y}`;
export function parentIndex(index: TileIndex): TileIndex | null {
  return index.z === 0
    ? null
    : {
        z: index.z - 1,
        x: Math.floor(index.x / 2),
        y: Math.floor(index.y / 2),
      };
}
export function tileBounds(index: TileIndex): TileBounds {
  const span = tileSpan(index.z);
  return {
    left: index.x * span,
    top: index.y * span,
    right: Math.min((index.x + 1) * span, WORLD_SIZE),
    bottom: Math.min((index.y + 1) * span, WORLD_SIZE),
  };
}
export function worldToTile(x: number, y: number, z: number) {
  if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE)
    throw new RangeError("world coordinate is out of bounds");
  const span = tileSpan(z);
  const scale = cellsPerTexel(z);
  const tile = { z, x: Math.floor(x / span), y: Math.floor(y / span) };
  return {
    tile,
    localX: Math.floor(x - tile.x * span),
    localY: Math.floor(y - tile.y * span),
    texelX: Math.floor((x - tile.x * span) / scale),
    texelY: Math.floor((y - tile.y * span) / scale),
  };
}
export function selectPyramidLevel(
  current: number | null,
  continuous: number,
): number {
  const nearest = clamp(Math.round(continuous), 0, MAX_ZOOM);
  if (current === null || Math.abs(continuous - current) > 1.65) return nearest;
  if (continuous > current + 0.65 || continuous < current - 0.65)
    return nearest;
  return current;
}
export function immediateParentRefinement(
  tiles: RefinementTile[],
  digest: string,
): void {
  const selectedZoom = tiles
    .filter((tile) => tile.isSelected)
    .reduce((max, tile) => Math.max(max, tile.index.z), -1);
  const byId = new Map(tiles.map((tile) => [tileId(tile.index), tile]));
  for (const tile of tiles) tile.isVisible = false;
  for (const tile of tiles) {
    if (!tile.isSelected || tile.index.z !== selectedZoom) continue;
    if (usable(tile, digest)) {
      tile.isVisible = true;
      continue;
    }
    const parent = parentIndex(tile.index);
    const fallback = parent && byId.get(tileId(parent));
    if (fallback && usable(fallback, digest)) fallback.isVisible = true;
  }
}
export function ring(indices: readonly TileIndex[]): TileIndex[] {
  const output = new Map<string, TileIndex>();
  for (const index of indices) {
    const count = tileCount(index.z);
    for (
      let y = Math.max(0, index.y - 1);
      y <= Math.min(count - 1, index.y + 1);
      y += 1
    )
      for (
        let x = Math.max(0, index.x - 1);
        x <= Math.min(count - 1, index.x + 1);
        x += 1
      ) {
        const candidate = { z: index.z, x, y };
        output.set(tileId(candidate), candidate);
      }
  }
  return [...output.values()];
}
function usable(tile: RefinementTile, digest: string): boolean {
  return tile.isLoaded && tile.content?.digest === digest;
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
