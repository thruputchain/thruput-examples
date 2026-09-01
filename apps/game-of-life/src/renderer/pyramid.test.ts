import { describe, expect, test } from "vitest";
import {
  immediateParentRefinement,
  parentIndex,
  ring,
  selectPyramidLevel,
  tileBounds,
  tileCount,
  tileSpan,
  worldToTile,
  type RefinementTile,
} from "./pyramid";
describe("tile pyramid", () => {
  test("has exact non-power-of-two dimensions", () => {
    expect(Array.from({ length: 7 }, (_, z) => tileCount(z))).toEqual([
      1, 2, 3, 5, 10, 20, 40,
    ]);
    expect(Array.from({ length: 7 }, (_, z) => tileSpan(z))).toEqual([
      16384, 8192, 4096, 2048, 1024, 512, 256,
    ]);
  });
  test("clips edge bounds and maps edge cells", () => {
    expect(tileBounds({ z: 6, x: 39, y: 39 })).toEqual({
      left: 9984,
      top: 9984,
      right: 10000,
      bottom: 10000,
    });
    expect(worldToTile(9999, 9999, 6)).toMatchObject({
      tile: { z: 6, x: 39, y: 39 },
      localX: 15,
      localY: 15,
    });
  });
  test("rejects outside coordinates", () =>
    expect(() => worldToTile(10000, 0, 6)).toThrow(RangeError));
  test("uses hysteresis", () => {
    expect(selectPyramidLevel(3, 3.64)).toBe(3);
    expect(selectPyramidLevel(3, 3.66)).toBe(4);
    expect(selectPyramidLevel(1, 5.9)).toBe(6);
  });
  test("returns one clipped prefetch ring", () => {
    const values = ring([{ z: 6, x: 0, y: 0 }]);
    expect(values).toHaveLength(4);
    expect(values).toContainEqual({ z: 6, x: 1, y: 1 });
    expect(ring([{ z: 6, x: 39, y: 39 }])).toHaveLength(4);
  });
  test("maps only an immediate parent", () =>
    expect(parentIndex({ z: 6, x: 39, y: 17 })).toEqual({ z: 5, x: 19, y: 8 }));
  test("shows loaded selected tiles or same-digest immediate parents only", () => {
    const tiles: RefinementTile[] = [
      tile(4, 0, 0, false, null),
      tile(3, 0, 0, true, "new"),
      tile(2, 0, 0, true, "new"),
    ];
    immediateParentRefinement(tiles, "new");
    expect(tiles.map((t) => t.isVisible)).toEqual([false, true, false]);
    tiles[1]!.content = { digest: "old" };
    immediateParentRefinement(tiles, "new");
    expect(tiles.every((t) => !t.isVisible)).toBe(true);
  });
});
function tile(
  z: number,
  x: number,
  y: number,
  isLoaded: boolean,
  digest: string | null,
): RefinementTile {
  return {
    index: { z, x, y },
    isSelected: true,
    isLoaded,
    content: digest ? { digest } : null,
    isVisible: true,
  };
}
