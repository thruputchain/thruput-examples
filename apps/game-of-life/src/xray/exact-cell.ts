import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { CELLS_CONTENT_TYPE, MAX_ZOOM, WORLD_SIZE } from "@/indexer/schema";
import { worldToTile, type TileIndex } from "@/renderer/pyramid";
import { bankRolesForGeneration } from "./workload";

const EXACT_TILE_BYTES = 8_192;
const PACKED_ROW_BYTES = 32;

export interface NeighborhoodCell {
  readonly x: number;
  readonly y: number;
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
  readonly alive: boolean;
}

export type ConwayOutcome =
  "birth" | "survival" | "loneliness" | "overcrowding" | "remains-dead";

export interface ExactCellInspection {
  readonly x: number;
  readonly y: number;
  readonly generation: string;
  readonly digest: string;
  readonly sourceBlockHeight: string;
  readonly verifiedAt: string;
  readonly cells: readonly NeighborhoodCell[];
  readonly byteCells: ReadonlyArray<
    Readonly<{ x: number; bit: number; alive: boolean }>
  >;
  readonly currentAlive: boolean;
  readonly liveNeighbors: number;
  readonly nextAlive: boolean;
  readonly outcome: ConwayOutcome;
  readonly tiles: readonly TileIndex[];
  readonly sourceBank: "A" | "B";
  readonly destinationBank: "A" | "B";
}

export async function inspectExactCell(
  client: IndexerClient,
  snapshot: ImmutableSnapshot,
  x: number,
  y: number,
  signal: AbortSignal,
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<ExactCellInspection> {
  const coordinates = neighborhoodCoordinates(x, y);
  const indices = uniqueTileIndices(coordinates);
  const payloads = new Map<string, Uint8Array>();
  await Promise.all(
    indices.map(async (index) => {
      payloads.set(
        tileKey(index),
        await fetchExactTile(client, snapshot, index, signal, fetcher),
      );
    }),
  );
  const cells = coordinates.map((coordinate) => {
    return {
      ...coordinate,
      alive: readCell(payloads, coordinate.x, coordinate.y),
    };
  });
  const firstXInByte = Math.floor(x / 8) * 8;
  const byteCells = Array.from({ length: 8 }, (_, bit) => ({
    x: firstXInByte + bit,
    bit,
    alive: readCell(payloads, firstXInByte + bit, y),
  }));
  const center = cells[4]!;
  const liveNeighbors = cells.reduce(
    (total, cell, index) => total + (index === 4 || !cell.alive ? 0 : 1),
    0,
  );
  const nextAlive =
    liveNeighbors === 3 || (center.alive && liveNeighbors === 2);
  const roles = bankRolesForGeneration(BigInt(snapshot.manifest.generation));
  return Object.freeze({
    x,
    y,
    generation: snapshot.manifest.generation,
    digest: snapshot.manifest.stateDigest,
    sourceBlockHeight: snapshot.provenance.sourceBlockHeight,
    verifiedAt: snapshot.provenance.verifiedAt,
    cells,
    byteCells,
    currentAlive: center.alive,
    liveNeighbors,
    nextAlive,
    outcome: conwayOutcome(center.alive, liveNeighbors),
    tiles: indices,
    sourceBank: roles.active,
    destinationBank: roles.inactive,
  });
}

export function neighborhoodCoordinates(
  x: number,
  y: number,
): ReadonlyArray<
  Readonly<{ x: number; y: number; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }>
> {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    x >= WORLD_SIZE ||
    y < 0 ||
    y >= WORLD_SIZE
  )
    throw new RangeError("Cell coordinate is outside the world");
  const result = [];
  for (const dy of [-1, 0, 1] as const)
    for (const dx of [-1, 0, 1] as const)
      result.push({
        x: wrap(x + dx),
        y: wrap(y + dy),
        dx,
        dy,
      });
  return result;
}

export function uniqueTileIndices(
  coordinates: ReadonlyArray<Readonly<{ x: number; y: number }>>,
): TileIndex[] {
  const indices = new Map<string, TileIndex>();
  for (const coordinate of coordinates) {
    const index = worldToTile(coordinate.x, coordinate.y, MAX_ZOOM).tile;
    indices.set(tileKey(index), index);
  }
  return [...indices.values()];
}

export function conwayOutcome(
  currentAlive: boolean,
  liveNeighbors: number,
): ConwayOutcome {
  if (
    !Number.isSafeInteger(liveNeighbors) ||
    liveNeighbors < 0 ||
    liveNeighbors > 8
  )
    throw new RangeError("Live-neighbor count must be between 0 and 8");
  if (!currentAlive) return liveNeighbors === 3 ? "birth" : "remains-dead";
  if (liveNeighbors < 2) return "loneliness";
  if (liveNeighbors > 3) return "overcrowding";
  return "survival";
}

async function fetchExactTile(
  client: IndexerClient,
  snapshot: ImmutableSnapshot,
  index: TileIndex,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(
    client.tileUrl(snapshot, index.z, index.x, index.y),
    {
      headers: { accept: CELLS_CONTENT_TYPE },
      redirect: "error",
      signal,
    },
  );
  if (!response.ok)
    throw new Error(`Exact-cell tile request failed (${response.status})`);
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== CELLS_CONTENT_TYPE)
    throw new Error(
      `Unexpected exact-cell content type: ${contentType ?? "missing"}`,
    );
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    response.headers.get("content-encoding") === null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) !== EXACT_TILE_BYTES)
  )
    throw new Error("Unexpected exact-cell content length");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== EXACT_TILE_BYTES)
    throw new Error("Unexpected exact-cell decoded length");
  return bytes;
}

function tileKey(index: TileIndex): string {
  return `${index.z}/${index.x}/${index.y}`;
}

function readCell(
  payloads: ReadonlyMap<string, Uint8Array>,
  x: number,
  y: number,
) {
  const mapped = worldToTile(x, y, MAX_ZOOM);
  const payload = payloads.get(tileKey(mapped.tile));
  if (!payload) throw new Error("Exact-cell tile was not loaded");
  const byte =
    payload[mapped.localY * PACKED_ROW_BYTES + Math.floor(mapped.localX / 8)]!;
  return ((byte >> (mapped.localX % 8)) & 1) === 1;
}

function wrap(value: number): number {
  return (value + WORLD_SIZE) % WORLD_SIZE;
}
