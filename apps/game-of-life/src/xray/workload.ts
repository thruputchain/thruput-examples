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
  initialWindowRows: 3,
  initialBankChunkReads: 6,
  streamBankChunkReads: 19_998,
  sourceRowBuffers: 3,
  destinationRowBuffers: 1,
  visibleRowWorkingSetBytes: 5_000,
  resultingPopulationCounts: 1,
  streamingDigests: 1,
});

export const EXECUTION_EVIDENCE = Object.freeze({
  groundhog: Object.freeze({
    protocol: "hogp/81e1cb073cfb",
    measuredSeconds: 7.04,
    source:
      "https://github.com/groundhogchain/groundhog-examples/blob/e1598b0d7c6dafde2199bcd2cdcc1ac88ddf995f/contracts/game-of-life/README.md",
  }),
  solana: Object.freeze({
    agaveVersion: "v3.1.8",
    maxAccountDataBytes: 10_485_760,
    maxTransactionComputeUnits: 1_400_000,
    accountsSource: "https://solana.com/docs/core/accounts",
    feesSource: "https://solana.com/docs/core/fees",
    meteringSource: "https://github.com/anza-xyz/sbpf/blob/v0.13.1/src/vm.rs",
  }),
  ethereum: Object.freeze({
    documentedBlockGasLimit: 60_000_000,
    illustrativeOpcodeGas: 2,
    storageSlotBytes: 32,
    accessListStorageKeyGas: 1_900,
    blocksSource: "https://ethereum.org/en/developers/docs/blocks/",
    opcodesSource: "https://ethereum.org/en/developers/docs/evm/opcodes/",
    storageSource: "https://eips.ethereum.org/EIPS/eip-2930",
  }),
});

export const SOLANA_BANK_OVERFLOW_BYTES =
  LIFE_WORKLOAD.bankBytes - EXECUTION_EVIDENCE.solana.maxAccountDataBytes;
export const SOLANA_MIN_ACCOUNTS_PER_BANK = Math.ceil(
  LIFE_WORKLOAD.bankBytes / EXECUTION_EVIDENCE.solana.maxAccountDataBytes,
);
export const SOLANA_COMPUTE_UNITS_PER_CELL =
  EXECUTION_EVIDENCE.solana.maxTransactionComputeUnits /
  LIFE_WORKLOAD.ruleEvaluations;
export const SOLANA_SCALAR_FLOOR_MULTIPLE =
  LIFE_WORKLOAD.ruleEvaluations /
  EXECUTION_EVIDENCE.solana.maxTransactionComputeUnits;

export const ETHEREUM_WRITE_SLOT_COUNT =
  LIFE_WORKLOAD.tickBankWriteBytes /
  EXECUTION_EVIDENCE.ethereum.storageSlotBytes;
export const ETHEREUM_PERSISTENT_SLOT_COUNT =
  LIFE_WORKLOAD.steadyStateBankBytes /
  EXECUTION_EVIDENCE.ethereum.storageSlotBytes;
export const ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS =
  ETHEREUM_WRITE_SLOT_COUNT *
  EXECUTION_EVIDENCE.ethereum.accessListStorageKeyGas;
export const ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE =
  ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS /
  EXECUTION_EVIDENCE.ethereum.documentedBlockGasLimit;
export const ETHEREUM_GAS_PER_CELL =
  EXECUTION_EVIDENCE.ethereum.documentedBlockGasLimit /
  LIFE_WORKLOAD.ruleEvaluations;
export const ETHEREUM_ONE_OPCODE_SCALAR_GAS =
  LIFE_WORKLOAD.ruleEvaluations *
  EXECUTION_EVIDENCE.ethereum.illustrativeOpcodeGas;
export const ETHEREUM_SCALAR_FLOOR_BLOCK_MULTIPLE =
  ETHEREUM_ONE_OPCODE_SCALAR_GAS /
  EXECUTION_EVIDENCE.ethereum.documentedBlockGasLimit;

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const CANONICAL_URL_COORDINATE = /^(?:0|[1-9][0-9]{0,3})$/;

export const DEFAULT_CELL = Object.freeze({ x: 5_000, y: 5_000 });

export interface CellCoordinate {
  readonly x: number;
  readonly y: number;
}

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

export function parseCellQuery(search: string): CellCoordinate {
  const query = new URLSearchParams(search);
  const xValues = query.getAll("cellX");
  const yValues = query.getAll("cellY");
  if (
    xValues.length !== 1 ||
    yValues.length !== 1 ||
    !CANONICAL_URL_COORDINATE.test(xValues[0] ?? "") ||
    !CANONICAL_URL_COORDINATE.test(yValues[0] ?? "")
  )
    return DEFAULT_CELL;
  const x = Number(xValues[0]);
  const y = Number(yValues[0]);
  return x < LIFE_WORKLOAD.worldWidth && y < LIFE_WORKLOAD.worldHeight
    ? Object.freeze({ x, y })
    : DEFAULT_CELL;
}

export function parseCoordinateInput(input: string): number | null {
  if (!/^[0-9]+$/.test(input)) return null;
  const value = Number(input);
  return Number.isSafeInteger(value) && value < LIFE_WORKLOAD.worldWidth
    ? value
    : null;
}

export function withCellQuery(input: URL, coordinate: CellCoordinate): URL {
  mapCellToStorage(coordinate.x, coordinate.y);
  const result = new URL(input);
  result.searchParams.set("cellX", String(coordinate.x));
  result.searchParams.set("cellY", String(coordinate.y));
  return result;
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
