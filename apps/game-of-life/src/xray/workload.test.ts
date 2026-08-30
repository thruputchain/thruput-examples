import { describe, expect, test } from "vitest";
import {
  bankRolesForGeneration,
  formatCount,
  LIFE_WORKLOAD,
  mapCellToStorage,
} from "./workload";

describe("Transaction X-Ray workload", () => {
  test("pins the complete storage arithmetic", () => {
    expect(LIFE_WORKLOAD.worldWidth).toBe(10_000);
    expect(LIFE_WORKLOAD.worldHeight).toBe(10_000);
    expect(LIFE_WORKLOAD.cellCount).toBe(100_000_000);
    expect(LIFE_WORKLOAD.bitsPerByte).toBe(8);
    expect(LIFE_WORKLOAD.rowBytes).toBe(1_250);
    expect(LIFE_WORKLOAD.chunkBytes).toBe(1_000);
    expect(LIFE_WORKLOAD.tailBytes).toBe(250);
    expect(LIFE_WORKLOAD.chunksPerRow).toBe(2);
    expect(LIFE_WORKLOAD.chunksPerBank).toBe(20_000);
    expect(LIFE_WORKLOAD.bankBytes).toBe(12_500_000);
    expect(LIFE_WORKLOAD.persistentBanks).toBe(2);
    expect(LIFE_WORKLOAD.steadyStateBankBytes).toBe(25_000_000);
    expect(LIFE_WORKLOAD.ruleEvaluations).toBe(100_000_000);
    expect(LIFE_WORKLOAD.cellCount).toBe(
      LIFE_WORKLOAD.worldWidth * LIFE_WORKLOAD.worldHeight,
    );
    expect(LIFE_WORKLOAD.rowBytes * 8).toBe(LIFE_WORKLOAD.worldWidth);
    expect(LIFE_WORKLOAD.chunkBytes + LIFE_WORKLOAD.tailBytes).toBe(
      LIFE_WORKLOAD.rowBytes,
    );
    expect(LIFE_WORKLOAD.chunksPerBank).toBe(
      LIFE_WORKLOAD.worldHeight * LIFE_WORKLOAD.chunksPerRow,
    );
    expect(LIFE_WORKLOAD.bankBytes).toBe(
      LIFE_WORKLOAD.worldHeight * LIFE_WORKLOAD.rowBytes,
    );
    expect(LIFE_WORKLOAD.steadyStateBankBytes).toBe(
      LIFE_WORKLOAD.bankBytes * LIFE_WORKLOAD.persistentBanks,
    );
    expect(LIFE_WORKLOAD.tickBankChunkReads).toBe(20_004);
    expect(3 * LIFE_WORKLOAD.chunksPerRow).toBe(6);
    expect((LIFE_WORKLOAD.worldHeight - 1) * LIFE_WORKLOAD.chunksPerRow).toBe(
      19_998,
    );
    expect(
      3 * LIFE_WORKLOAD.chunksPerRow +
        (LIFE_WORKLOAD.worldHeight - 1) * LIFE_WORKLOAD.chunksPerRow,
    ).toBe(LIFE_WORKLOAD.tickBankChunkReads);
    expect(LIFE_WORKLOAD.tickBankChunkWrites).toBe(20_000);
    expect(LIFE_WORKLOAD.tickBankReadBytes).toBe(12_502_500);
    expect(LIFE_WORKLOAD.tickBankWriteBytes).toBe(12_500_000);
    expect(LIFE_WORKLOAD.tickBankReadBytes).toBe(
      LIFE_WORKLOAD.bankBytes + 2 * LIFE_WORKLOAD.rowBytes,
    );
    expect(LIFE_WORKLOAD.tickBankWriteBytes).toBe(LIFE_WORKLOAD.bankBytes);
  });

  test.each([
    [0, 0, 0, 0, 0, 0, 0],
    [7, 0, 0, 7, 0, 0, 0],
    [8, 0, 1, 0, 0, 1, 0],
    [7_999, 4_321, 999, 7, 0, 999, 8_642],
    [8_000, 4_321, 1_000, 0, 1, 0, 8_643],
    [9_999, 9_999, 1_249, 7, 1, 249, 19_999],
  ])(
    "maps cell (%i, %i) to its canonical storage address",
    (x, y, byteInRow, bit, part, byteInPart, chunkKey) => {
      expect(mapCellToStorage(x, y)).toEqual({
        x,
        y,
        byteInRow,
        bit,
        part,
        byteInPart,
        chunkKey,
      });
    },
  );

  test.each([
    [-1, 0],
    [0, -1],
    [10_000, 0],
    [0, 10_000],
    [0.5, 0],
    [Number.NaN, 0],
  ])("rejects invalid coordinate (%s, %s)", (x, y) => {
    expect(() => mapCellToStorage(x, y)).toThrow(RangeError);
  });

  test("derives alternating banks without lossy number conversion", () => {
    expect(bankRolesForGeneration(0n)).toEqual({ active: "A", inactive: "B" });
    expect(bankRolesForGeneration(1n)).toEqual({ active: "B", inactive: "A" });
    expect(bankRolesForGeneration(18_446_744_073_709_551_614n)).toEqual({
      active: "A",
      inactive: "B",
    });
    expect(bankRolesForGeneration(18_446_744_073_709_551_615n)).toEqual({
      active: "B",
      inactive: "A",
    });
    expect(() => bankRolesForGeneration(-1n)).toThrow(RangeError);
  });

  test("formats exact decimal counts consistently", () => {
    expect(formatCount(100_000_000)).toBe("100,000,000");
    expect(formatCount(12_500_000n)).toBe("12,500,000");
  });
});
