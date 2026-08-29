export const WORLD_SIZE = 10_000;
export const TILE_SIZE = 256;
export const MAX_ZOOM = 6;

export interface TileIndex {
  x: number;
  y: number;
  z: number;
}

export interface TileBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RefinementTile {
  index: TileIndex;
  isSelected: boolean;
  isLoaded: boolean;
  content: { digest: string } | null;
  isVisible: boolean;
}

export function cellsPerTexel(zoom: number): number {
  return 2 ** (MAX_ZOOM - zoom);
}

export function tileSpan(zoom: number): number {
  return TILE_SIZE * cellsPerTexel(zoom);
}

export function tileCount(zoom: number): number {
  return Math.ceil(WORLD_SIZE / tileSpan(zoom));
}

export function tileId(index: TileIndex): string {
  return `${index.z}/${index.x}/${index.y}`;
}

export function parentIndex(index: TileIndex): TileIndex | null {
  if (index.z === 0) {
    return null;
  }
  return {
    x: Math.floor(index.x / 2),
    y: Math.floor(index.y / 2),
    z: index.z - 1,
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

export function worldToTile(x: number, y: number, zoom: number): {
  tile: TileIndex;
  texelX: number;
  texelY: number;
} {
  if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE) {
    throw new RangeError("world coordinate is out of bounds");
  }
  const span = tileSpan(zoom);
  const scale = cellsPerTexel(zoom);
  const tile = {
    x: Math.floor(x / span),
    y: Math.floor(y / span),
    z: zoom,
  };
  return {
    tile,
    texelX: Math.floor((x - tile.x * span) / scale),
    texelY: Math.floor((y - tile.y * span) / scale),
  };
}

export function selectPyramidLevel(current: number | null, continuous: number): number {
  const nearest = clamp(Math.round(continuous), 0, MAX_ZOOM);
  if (current === null || Math.abs(continuous - current) > 1.65) {
    return nearest;
  }
  if (continuous > current + 0.65) {
    return Math.min(current + 1, MAX_ZOOM);
  }
  if (continuous < current - 0.65) {
    return Math.max(current - 1, 0);
  }
  return current;
}

export function clampCameraTarget(
  target: readonly [number, number],
  visibleWidth: number,
  visibleHeight: number,
): [number, number] {
  return [
    clampAxis(target[0], visibleWidth),
    clampAxis(target[1], visibleHeight),
  ];
}

export function applyStrictImmediateParentRefinement(
  tiles: RefinementTile[],
  expectedDigest: string,
): void {
  const selectedZoom = tiles
    .filter((tile) => tile.isSelected)
    .reduce((maximum, tile) => Math.max(maximum, tile.index.z), -1);
  const byId = new Map(tiles.map((tile) => [tileId(tile.index), tile]));

  for (const tile of tiles) {
    tile.isVisible = false;
  }
  for (const tile of tiles) {
    if (!tile.isSelected || tile.index.z !== selectedZoom) {
      continue;
    }
    if (isUsable(tile, expectedDigest)) {
      tile.isVisible = true;
      continue;
    }
    const parent = parentIndex(tile.index);
    const fallback = parent && byId.get(tileId(parent));
    if (fallback && isUsable(fallback, expectedDigest)) {
      fallback.isVisible = true;
    }
  }
}

export function hasCompleteSelectedCoverage(
  tiles: readonly RefinementTile[],
  digest: string,
): boolean {
  const selectedZoom = tiles
    .filter((tile) => tile.isSelected)
    .reduce((maximum, tile) => Math.max(maximum, tile.index.z), -1);
  const selected = tiles.filter(
    (tile) => tile.isSelected && tile.index.z === selectedZoom,
  );
  return selected.length > 0 && selected.every((tile) => isUsable(tile, digest));
}

function isUsable(tile: RefinementTile, digest: string): boolean {
  return (
    tile.isLoaded &&
    tile.content !== null &&
    tile.content.digest === digest
  );
}

function clampAxis(value: number, visibleSpan: number): number {
  if (visibleSpan >= WORLD_SIZE) {
    return WORLD_SIZE / 2;
  }
  const half = visibleSpan / 2;
  return clamp(value, half, WORLD_SIZE - half);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
