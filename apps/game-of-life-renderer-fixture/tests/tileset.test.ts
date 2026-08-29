import { OrthographicViewport } from "@deck.gl/core";
import { describe, expect, test } from "vitest";
import { HystereticLifeTileset } from "../src/life-tileset";
import {
  applyStrictImmediateParentRefinement,
  hasCompleteSelectedCoverage,
  type RefinementTile,
} from "../src/model";

describe("HystereticLifeTileset", () => {
  test("selects every pyramid level through deck.gl", () => {
    for (let level = 0; level <= 6; level += 1) {
      const tileset = createTileset();
      const selected = indices(tileset, viewport(level - 6));
      expect(Math.max(...selected.map(({ z }) => z))).toBe(level);
      expect(new Set(selected.map(({ z }) => z))).toEqual(
        level === 0 ? new Set([0]) : new Set([level - 1, level]),
      );
      tileset.finalize();
    }
  });

  test("schedules only the selected level and its immediate parents", () => {
    const tileset = createTileset();
    const initial = indices(tileset, viewport(-3));
    expect(new Set(initial.map(({ z }) => z))).toEqual(new Set([2, 3]));

    const insideBand = indices(tileset, viewport(-2.4));
    expect(Math.max(...insideBand.map(({ z }) => z))).toBe(3);

    const pastThreshold = indices(tileset, viewport(-2.3));
    expect(new Set(pastThreshold.map(({ z }) => z))).toEqual(new Set([3, 4]));
    tileset.finalize();
  });

  test("selects the clipped level-six edge without padded tiles", () => {
    const tileset = createTileset();
    const selected = indices(tileset, viewport(0, [9_999, 9_999]));
    const levelSix = selected.filter(({ z }) => z === 6);
    expect(levelSix).toContainEqual({ x: 39, y: 39, z: 6 });
    expect(levelSix.every(({ x, y }) => x < 40 && y < 40)).toBe(true);
    expect(new Set(selected.map(({ z }) => z))).toEqual(new Set([5, 6]));
    tileset.finalize();
  });

  test("does not refine against cached tiles from an old zoom", async () => {
    const tileset = new HystereticLifeTileset({
      extent: [0, 0, 10_000, 10_000],
      tileSize: 16_384,
      minZoom: 0,
      maxZoom: 6,
      zoomOffset: 6,
      getTileData: () => ({ byteLength: 1, digest: "new" }),
      refinementStrategy: (tiles) => {
        applyStrictImmediateParentRefinement(tiles, "new");
      },
    });
    update(tileset, viewport(0));
    await waitForLoaded(tileset, viewport(0), 6);
    update(tileset, viewport(0));
    expect(tileset.tiles.some(({ index }) => index.z === 6)).toBe(true);

    update(tileset, viewport(-3));
    expect(
      hasCompleteSelectedCoverage(tileset.selectedTiles as RefinementTile[], "new"),
    ).toBe(false);
    await waitForLoaded(tileset, viewport(-3), 3);
    update(tileset, viewport(-3));
    const visible = tileset.tiles.filter(({ isVisible }) => isVisible);
    expect(visible.some(({ index }) => index.z === 3)).toBe(true);
    expect(visible.every(({ index }) => index.z <= 3)).toBe(true);

    expect(
      hasCompleteSelectedCoverage(tileset.selectedTiles as RefinementTile[], "new"),
    ).toBe(true);
    tileset.finalize();
  });
});

function createTileset(): HystereticLifeTileset {
  return new HystereticLifeTileset({
    extent: [0, 0, 10_000, 10_000],
    tileSize: 16_384,
    minZoom: 0,
    maxZoom: 6,
    zoomOffset: 6,
    getTileData: () => ({ byteLength: 0 }),
  });
}

function viewport(
  zoom: number,
  target: [number, number] = [5_000, 5_000],
): OrthographicViewport {
  return new OrthographicViewport({
    id: "life",
    width: 512,
    height: 512,
    target: [target[0], target[1], 0],
    zoom,
    flipY: true,
  });
}

function indices(
  tileset: HystereticLifeTileset,
  currentViewport: OrthographicViewport,
): Array<{ x: number; y: number; z: number }> {
  return tileset.getTileIndices({
    viewport: currentViewport,
    minZoom: 0,
    maxZoom: 6,
    zRange: null,
  });
}

function update(
  tileset: HystereticLifeTileset,
  currentViewport: OrthographicViewport,
): void {
  tileset.update(currentViewport, { zRange: null, modelMatrix: null });
}

async function waitForLoaded(
  tileset: HystereticLifeTileset,
  currentViewport: OrthographicViewport,
  zoom: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    update(tileset, currentViewport);
    const selected = (tileset.selectedTiles ?? []).filter((tile) => tile.index.z === zoom);
    if (selected.length > 0 && selected.every((tile) => tile.isLoaded)) {
      return;
    }
  }
  throw new Error(`tiles at zoom ${zoom} did not load`);
}
