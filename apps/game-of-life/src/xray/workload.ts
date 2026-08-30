export const LIFE_WORKLOAD = Object.freeze({
  worldWidth: 10_000,
  worldHeight: 10_000,
  cellCount: 100_000_000,
  bitsPerByte: 8,
  rowBytes: 1_250,
  chunkBytes: 1_000,
  tailBytes: 250,
  chunksPerRow: 2,
  chunksPerBank: 20_000,
  bankBytes: 12_500_000,
  persistentBanks: 2,
  steadyStateBankBytes: 25_000_000,
  tickBankChunkReads: 20_004,
  tickBankChunkWrites: 20_000,
  tickBankReadBytes: 12_502_500,
  tickBankWriteBytes: 12_500_000,
  ruleEvaluations: 100_000_000,
});

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export interface CellStorageAddress {
  readonly x: number;
  readonly y: number;
  readonly byteInRow: number;
  readonly bit: number;
  readonly part: 0 | 1;
  readonly byteInPart: number;
  readonly chunkKey: number;
}

export interface BankRoles {
  readonly active: "A" | "B";
  readonly inactive: "A" | "B";
}

export function mapCellToStorage(x: number, y: number): CellStorageAddress {
  assertCoordinate(x, "x");
  assertCoordinate(y, "y");
  const byteInRow = Math.floor(x / LIFE_WORKLOAD.bitsPerByte);
  const part = byteInRow < LIFE_WORKLOAD.chunkBytes ? 0 : 1;
  return Object.freeze({
    x,
    y,
    byteInRow,
    bit: x % LIFE_WORKLOAD.bitsPerByte,
    part,
    byteInPart: part === 0 ? byteInRow : byteInRow - LIFE_WORKLOAD.chunkBytes,
    chunkKey: y * LIFE_WORKLOAD.chunksPerRow + part,
  });
}

export function bankRolesForGeneration(generation: bigint): BankRoles {
  if (generation < 0n) throw new RangeError("generation must be nonnegative");
  return generation % 2n === 0n
    ? Object.freeze({ active: "A", inactive: "B" })
    : Object.freeze({ active: "B", inactive: "A" });
}

export function formatCount(value: number | bigint): string {
  return COUNT_FORMATTER.format(value);
}

function assertCoordinate(value: number, axis: "x" | "y"): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >=
      (axis === "x" ? LIFE_WORKLOAD.worldWidth : LIFE_WORKLOAD.worldHeight)
  )
    throw new RangeError(`${axis} must be an integer from 0 through 9999`);
}
