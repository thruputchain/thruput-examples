import { describe, expect, test } from "vitest";
import { renderingMode, scaleRuler } from "./viewport-presentation";

describe("viewport presentation", () => {
  test.each([
    [0, -6, "Density · 64 × 64 cells per sample"],
    [3, -2.4, "Density · 8 × 8 cells per sample"],
    [6, 0, "Exact cells · 1 px per cell"],
    [6, 4, "Exact cells · 16 px per cell"],
  ])("describes level %s at zoom %s", (level, zoom, label) =>
    expect(renderingMode(level, zoom)).toBe(label),
  );

  test.each([
    [0, 50, 50],
    [4, 5, 80],
    [-2.679, 500, 78.07],
  ])("selects a readable ruler at zoom %s", (zoom, cells, pixels) => {
    const ruler = scaleRuler(zoom);
    expect(ruler.cells).toBe(cells);
    expect(ruler.pixels).toBeCloseTo(pixels, 2);
  });
});
