import { describe, expect, test } from "vitest";
import { LIFE_FRAGMENT_SHADER } from "./life-tile-layer";
import { HATCH_FRAGMENT_SHADER } from "./unavailable-tile-layer";

describe("custom layer opacity", () => {
  test.each([LIFE_FRAGMENT_SHADER, HATCH_FRAGMENT_SHADER])(
    "uses straight alpha exactly once",
    (shader) => {
      expect(shader).toMatch(/vec4\(color, alpha\)/);
      expect(shader).toMatch(/layerOpacity/);
      expect(shader).not.toMatch(/color \* alpha/);
      expect(shader).not.toMatch(/vec4\(color, 1\.\)/);
    },
  );

  test("intermediate opacity is not squared", () => {
    const source = 0.8;
    const destination = 0.2;
    const alpha = 0.5;
    const straight = source * alpha + destination * (1 - alpha);
    const opacitySquared = source * alpha * alpha + destination * (1 - alpha);
    expect(straight).toBeCloseTo(0.5);
    expect(opacitySquared).toBeCloseTo(0.3);
  });
});
