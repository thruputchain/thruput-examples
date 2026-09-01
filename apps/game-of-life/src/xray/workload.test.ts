import { describe, expect, test } from "vitest";
import {
  bankRolesForGeneration,
  DEFAULT_CELL,
  ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE,
  ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS,
  ETHEREUM_GAS_PER_CELL,
  ETHEREUM_ONE_OPCODE_SCALAR_GAS,
  ETHEREUM_PERSISTENT_SLOT_COUNT,
  ETHEREUM_SCALAR_FLOOR_BLOCK_MULTIPLE,
  ETHEREUM_WRITE_SLOT_COUNT,
  EXECUTION_EVIDENCE,
  formatCount,
  LIFE_WORKLOAD,
  mapCellToStorage,
  parseCellQuery,
  parseCoordinateInput,
  SOLANA_BANK_OVERFLOW_BYTES,
  SOLANA_COMPUTE_UNITS_PER_CELL,
  SOLANA_MIN_ACCOUNTS_PER_BANK,
  SOLANA_SCALAR_FLOOR_MULTIPLE,
  withCellQuery,
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
    expect(LIFE_WORKLOAD.initialWindowRows).toBe(3);
    expect(LIFE_WORKLOAD.initialBankChunkReads).toBe(6);
    expect(LIFE_WORKLOAD.streamBankChunkReads).toBe(19_998);
    expect(LIFE_WORKLOAD.sourceRowBuffers).toBe(3);
    expect(LIFE_WORKLOAD.destinationRowBuffers).toBe(1);
    expect(LIFE_WORKLOAD.visibleRowWorkingSetBytes).toBe(5_000);
    expect(LIFE_WORKLOAD.resultingPopulationCounts).toBe(1);
    expect(LIFE_WORKLOAD.streamingDigests).toBe(1);
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
    expect(LIFE_WORKLOAD.initialWindowRows * LIFE_WORKLOAD.chunksPerRow).toBe(
      LIFE_WORKLOAD.initialBankChunkReads,
    );
    expect((LIFE_WORKLOAD.worldHeight - 1) * LIFE_WORKLOAD.chunksPerRow).toBe(
      LIFE_WORKLOAD.streamBankChunkReads,
    );
    expect(
      LIFE_WORKLOAD.initialBankChunkReads + LIFE_WORKLOAD.streamBankChunkReads,
    ).toBe(LIFE_WORKLOAD.tickBankChunkReads);
    expect(LIFE_WORKLOAD.tickBankChunkWrites).toBe(20_000);
    expect(LIFE_WORKLOAD.tickBankReadBytes).toBe(12_502_500);
    expect(LIFE_WORKLOAD.tickBankWriteBytes).toBe(12_500_000);
    expect(LIFE_WORKLOAD.tickBankReadBytes).toBe(
      LIFE_WORKLOAD.bankBytes + 2 * LIFE_WORKLOAD.rowBytes,
    );
    expect(LIFE_WORKLOAD.tickBankWriteBytes).toBe(LIFE_WORKLOAD.bankBytes);
    expect(
      (LIFE_WORKLOAD.sourceRowBuffers + LIFE_WORKLOAD.destinationRowBuffers) *
        LIFE_WORKLOAD.rowBytes,
    ).toBe(LIFE_WORKLOAD.visibleRowWorkingSetBytes);
  });

  test("pins execution limits and comparison arithmetic", () => {
    expect(EXECUTION_EVIDENCE.groundhog).toMatchObject({
      protocol: "hogp/81e1cb073cfb",
      measuredSeconds: 7.04,
    });
    expect(EXECUTION_EVIDENCE.solana).toMatchObject({
      agaveVersion: "v3.1.8",
      maxAccountDataBytes: 10_485_760,
      maxTransactionComputeUnits: 1_400_000,
    });
    expect(EXECUTION_EVIDENCE.ethereum).toMatchObject({
      documentedBlockGasLimit: 60_000_000,
      storageSlotBytes: 32,
      accessListStorageKeyGas: 1_900,
    });
    expect(SOLANA_BANK_OVERFLOW_BYTES).toBe(2_014_240);
    expect(SOLANA_MIN_ACCOUNTS_PER_BANK).toBe(2);
    expect(SOLANA_COMPUTE_UNITS_PER_CELL).toBe(0.014);
    expect(SOLANA_SCALAR_FLOOR_MULTIPLE).toBeCloseTo(71.43);
    expect(ETHEREUM_PERSISTENT_SLOT_COUNT).toBe(781_250);
    expect(ETHEREUM_WRITE_SLOT_COUNT).toBe(390_625);
    expect(ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS).toBe(742_187_500);
    expect(ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE).toBeCloseTo(12.37);
    expect(ETHEREUM_GAS_PER_CELL).toBe(0.6);
    expect(ETHEREUM_ONE_OPCODE_SCALAR_GAS).toBe(200_000_000);
    expect(ETHEREUM_SCALAR_FLOOR_BLOCK_MULTIPLE).toBeCloseTo(3.33);
    expect(ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS).toBeGreaterThan(
      EXECUTION_EVIDENCE.ethereum.documentedBlockGasLimit,
    );
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

  test.each([
    ["?cellX=0&cellY=9999", { x: 0, y: 9_999 }],
    ["?cellX=5000&cellY=5000", { x: 5_000, y: 5_000 }],
    ["?view=proof&cellX=42&cellY=7", { x: 42, y: 7 }],
  ])("parses canonical X-Ray query %s", (search, expected) => {
    expect(parseCellQuery(search)).toEqual(expected);
  });

  test.each([
    "",
    "?cellX=1",
    "?cellY=1",
    "?cellX=1&cellX=2&cellY=3",
    "?cellX=1&cellY=2&cellY=3",
    "?cellX=01&cellY=2",
    "?cellX=+1&cellY=2",
    "?cellX=-0&cellY=2",
    "?cellX=%201&cellY=2",
    "?cellX=1.5&cellY=2",
    "?cellX=1e2&cellY=2",
    "?cellX=10000&cellY=2",
    "?cellX=1&cellY=10000",
  ])("falls back for invalid X-Ray query %s", (search) => {
    expect(parseCellQuery(search)).toEqual(DEFAULT_CELL);
  });

  test.each([
    ["0", 0],
    ["0008", 8],
    ["9999", 9_999],
    ["", null],
    ["-1", null],
    ["1.5", null],
    ["10 00", null],
    ["10000", null],
  ])("validates coordinate input %s", (input, expected) => {
    expect(parseCoordinateInput(input)).toBe(expected);
  });

  test("updates only namespaced coordinate query values", () => {
    const input = new URL(
      "http://127.0.0.1/xray?cellX=1&cellX=2&cellY=3&view=proof#atlas",
    );
    expect(withCellQuery(input, { x: 8_000, y: 4_321 }).href).toBe(
      "http://127.0.0.1/xray?cellX=8000&cellY=4321&view=proof#atlas",
    );
    expect(input.searchParams.getAll("cellX")).toEqual(["1", "2"]);
  });
});
