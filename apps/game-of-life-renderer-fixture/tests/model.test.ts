import { describe, expect, test } from "vitest";
import {
  applyStrictImmediateParentRefinement,
  clampCameraTarget,
  hasCompleteSelectedCoverage,
  parentIndex,
  selectPyramidLevel,
  tileBounds,
  tileCount,
  tileSpan,
  worldToTile,
  type RefinementTile,
  type TileIndex,
} from "../src/model";

describe("Life tile pyramid", () => {
  test("uses the required non-power-of-two tile counts", () => {
    expect(Array.from({ length: 7 }, (_, zoom) => tileCount(zoom))).toEqual([
      1, 2, 3, 5, 10, 20, 40,
    ]);
    expect(Array.from({ length: 7 }, (_, zoom) => tileSpan(zoom))).toEqual([
      16_384, 8_192, 4_096, 2_048, 1_024, 512, 256,
    ]);
  });

  test("clips edge tile bounds to the real world", () => {
    expect(tileBounds({ x: 39, y: 39, z: 6 })).toEqual({
      left: 9_984,
      top: 9_984,
      right: 10_000,
      bottom: 10_000,
    });
  });

  test("maps boundary cells to exact tiles and texels", () => {
    expect(worldToTile(0, 0, 6)).toEqual({
      tile: { x: 0, y: 0, z: 6 },
      texelX: 0,
      texelY: 0,
    });
    expect(worldToTile(9_999, 9_999, 6)).toEqual({
      tile: { x: 39, y: 39, z: 6 },
      texelX: 15,
      texelY: 15,
    });
    expect(() => worldToTile(10_000, 0, 6)).toThrow(RangeError);
  });

  test("maps only to an immediate parent", () => {
    expect(parentIndex({ x: 39, y: 17, z: 6 })).toEqual({ x: 19, y: 8, z: 5 });
    expect(parentIndex({ x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe("camera policy", () => {
  test("holds a level inside the hysteresis band", () => {
    expect(selectPyramidLevel(3, 3.64)).toBe(3);
    expect(selectPyramidLevel(3, 3.66)).toBe(4);
    expect(selectPyramidLevel(3, 2.36)).toBe(3);
    expect(selectPyramidLevel(3, 2.34)).toBe(2);
    expect(selectPyramidLevel(1, 5.9)).toBe(6);
  });

  test("clamps the camera to the real world", () => {
    expect(clampCameraTarget([-50, 10_100], 1_000, 2_000)).toEqual([500, 9_000]);
    expect(clampCameraTarget([1, 2], 12_000, 20_000)).toEqual([5_000, 5_000]);
  });
});

describe("generation-safe refinement", () => {
  test("shows a loaded selected tile and only an immediate parent fallback", () => {
    const tiles = [
      tile({ x: 0, y: 0, z: 4 }, true, "new"),
      tile({ x: 1, y: 0, z: 4 }, false, null),
      tile({ x: 0, y: 0, z: 3 }, true, "new"),
      tile({ x: 0, y: 0, z: 2 }, true, "new"),
      tile({ x: 0, y: 0, z: 6 }, true, "new", false),
    ];
    applyStrictImmediateParentRefinement(tiles, "new");
    expect(tiles.map(({ isVisible }) => isVisible)).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  test("rejects unavailable and cross-digest parents", () => {
    const tiles = [
      tile({ x: 0, y: 0, z: 4 }, true, "new"),
      tile({ x: 1, y: 0, z: 4 }, false, null),
      tile({ x: 0, y: 0, z: 3 }, true, "old"),
    ];
    applyStrictImmediateParentRefinement(tiles, "new");
    expect(tiles.map(({ isVisible }) => isVisible)).toEqual([true, false, false]);
  });

  test("rejects a cross-digest parent before selected tiles load", () => {
    const tiles = [
      tile({ x: 0, y: 0, z: 4 }, false, null),
      tile({ x: 0, y: 0, z: 3 }, true, "old"),
    ];
    applyStrictImmediateParentRefinement(tiles, "new");
    expect(tiles.map(({ isVisible }) => isVisible)).toEqual([false, false]);
  });

  test("requires selected-level coverage", () => {
    const selected = [
      tile({ x: 0, y: 0, z: 6 }, true, "new"),
      tile({ x: 1, y: 0, z: 6 }, false, null),
    ];
    expect(hasCompleteSelectedCoverage(selected, "new")).toBe(false);
    selected[1] = tile({ x: 1, y: 0, z: 6 }, true, "new");
    expect(hasCompleteSelectedCoverage(selected, "new")).toBe(true);
    selected[1] = tile({ x: 1, y: 0, z: 6 }, true, "old");
    expect(hasCompleteSelectedCoverage(selected, "new")).toBe(false);
    expect(hasCompleteSelectedCoverage([], "new")).toBe(false);
  });
});

function tile(
  index: TileIndex,
  isLoaded: boolean,
  digest: string | null,
  isSelected = true,
): RefinementTile {
  return {
    index,
    isSelected,
    isLoaded,
    content: digest ? { digest } : null,
    isVisible: true,
  };
}
