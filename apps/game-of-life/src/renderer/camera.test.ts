import { describe, expect, test } from "vitest";
import {
  clampCamera,
  fitCamera,
  parseCamera,
  serializeCamera,
  zoomAround,
} from "./camera";
describe("camera", () => {
  test("fits the complete world", () =>
    expect(fitCamera(1000, 500)).toEqual({
      x: 5000,
      y: 5000,
      zoom: Math.log2(0.05),
    }));
  test("clamps to real world bounds", () =>
    expect(clampCamera({ x: -5, y: 10050, zoom: 0 }, 512, 512)).toEqual({
      x: 256,
      y: 9744,
      zoom: 0,
    }));
  test("uses the clamped zoom when constraining the center", () =>
    expect(clampCamera({ x: 0, y: 0, zoom: 10 }, 512, 512)).toEqual({
      x: 256,
      y: 256,
      zoom: 0,
    }));
  test("preserves the world point under pointer zoom", () => {
    const camera = { x: 5000, y: 5000, zoom: -2 };
    const next = zoomAround(camera, -1, [700, 300], [800, 600]);
    expect(next).toEqual({ x: 5600, y: 5000, zoom: -1 });
  });
  test("round trips bounded URL state", () => {
    const camera = { x: 123.25, y: 9876.5, zoom: -2.5 };
    expect(parseCamera(serializeCamera(camera))).toEqual(camera);
  });
  test.each([
    "?x=-1&y=0&z=0",
    "?x=0&y=0&z=1",
    "?x=0&y=0&z=0&evil=1",
    "?x=x&y=0&z=0",
    "?x=0&y=0",
    "?x=0&x=1&y=0&z=0",
  ])("rejects unsafe query %s", (query) =>
    expect(parseCamera(query)).toBeNull(),
  );
});
