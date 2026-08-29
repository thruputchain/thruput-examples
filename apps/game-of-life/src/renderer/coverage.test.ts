import { describe, expect, test } from "vitest";
import { hasRequiredCoverage } from "./coverage";

const digest = `0x${"aa".repeat(32)}`;

describe("generation render coverage", () => {
  test("requires exact render-ready selected tiles at level six", () => {
    const ready = new Set([`${digest}:5/0/0`]);
    const visible = [{ z: 6, x: 0, y: 0 }];
    expect(hasRequiredCoverage(visible, digest, (key) => ready.has(key))).toBe(
      false,
    );
    ready.add(`${digest}:6/0/0`);
    expect(hasRequiredCoverage(visible, digest, (key) => ready.has(key))).toBe(
      true,
    );
  });

  test("allows only a render-ready immediate parent at density levels", () => {
    const visible = [{ z: 4, x: 2, y: 2 }];
    const ready = new Set([`${digest}:2/0/0`]);
    expect(hasRequiredCoverage(visible, digest, (key) => ready.has(key))).toBe(
      false,
    );
    ready.add(`${digest}:3/1/1`);
    expect(hasRequiredCoverage(visible, digest, (key) => ready.has(key))).toBe(
      true,
    );
  });

  test("does not count decoded, missing, or failed tiles without resources", () => {
    expect(
      hasRequiredCoverage([{ z: 0, x: 0, y: 0 }], digest, () => false),
    ).toBe(false);
  });
});
