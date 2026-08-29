import { describe, expect, test } from "vitest";
import { CELLS_CONTENT_TYPE, DENSITY_CONTENT_TYPE } from "@/indexer/schema";
import { ByteBudget } from "./budget";
import { CELL_BYTES, decodeTile, DENSITY_BYTES } from "./decode";
import { inspect } from "./inspection";
describe("tile decoding and inspection", () => {
  test("decodes unsigned little-endian density exactly", () => {
    const bytes = new ArrayBuffer(DENSITY_BYTES);
    const view = new DataView(bytes);
    view.setUint16(2, 513, true);
    const tile = decodeTile(bytes, DENSITY_CONTENT_TYPE, 0);
    expect(tile.kind).toBe("density");
    if (tile.kind === "density") expect(tile.values[1]).toBe(513);
  });
  test("decodes exact LSB-first bits while retaining packed bytes", () => {
    const bytes = new ArrayBuffer(CELL_BYTES);
    new Uint8Array(bytes)[0] = 0b10000001;
    const tile = decodeTile(bytes, CELLS_CONTENT_TYPE, 6);
    expect(tile.kind).toBe("cells");
    if (tile.kind === "cells") {
      expect(tile.values.slice(0, 8)).toEqual(
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1]),
      );
      expect(inspect(tile, 0, 0, 6, "12")).toMatchObject({
        kind: "cell",
        alive: true,
      });
      expect(inspect(tile, 1, 0, 6, "12")).toMatchObject({
        kind: "cell",
        alive: false,
      });
    }
  });
  test("reports exact covered count at a partial edge", () => {
    const tile = { kind: "density" as const, values: new Uint16Array(65536) };
    tile.values[156 * 256 + 156] = 9;
    expect(inspect(tile, 9999, 9999, 0, "12")).toMatchObject({
      kind: "density",
      live: 9,
      covered: 256,
    });
  });
  test.each([
    [new ArrayBuffer(1), DENSITY_CONTENT_TYPE, 0],
    [new ArrayBuffer(DENSITY_BYTES), CELLS_CONTENT_TYPE, 0],
    [new ArrayBuffer(CELL_BYTES), DENSITY_CONTENT_TYPE, 6],
  ] as const)("rejects wrong length or type", (bytes, type, z) =>
    expect(() => decodeTile(bytes, type, z)).toThrow(),
  );
});
describe("byte budget", () => {
  test("evicts least-recently-used entries and finalizes resources", () => {
    const finalized: string[] = [];
    const budget = new ByteBudget<number>(10);
    budget.set("a", 1, 6, () => finalized.push("a"));
    budget.set("b", 2, 4, () => finalized.push("b"));
    expect(budget.get("a")).toBe(1);
    budget.set("c", 3, 4, () => finalized.push("c"));
    expect(finalized).toEqual(["b"]);
    expect(budget.byteLength).toBe(10);
    budget.clear();
    expect(finalized).toEqual(["b", "a", "c"]);
    expect(budget.byteLength).toBe(0);
  });
  test("rejects an individually over-budget resource", () =>
    expect(() => new ByteBudget(4).set("x", true, 5)).toThrow(RangeError));
});
