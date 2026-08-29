export const WORLD_SIZE = 10_000;
export const TILE_SIZE = 256;
export const MAX_ZOOM = 6;
export const DENSITY_CONTENT_TYPE =
  "application/vnd.groundhog.life-density-u16le";
export const CELLS_CONTENT_TYPE = "application/vnd.groundhog.life-cells-v1";

const HEX32 = /^0x[0-9a-f]{64}$/;
const NETWORK = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ERROR_CODE = /^[A-Z0-9_]+$/;

export interface SnapshotIdentity {
  readonly networkId: string;
  readonly contractAddress: string;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
}

export interface LifeManifest extends SnapshotIdentity {
  readonly schemaVersion: 1;
  readonly width: 10_000;
  readonly height: 10_000;
  readonly tileSize: 256;
  readonly maxZoom: 6;
  readonly densityEncoding: "u16le-live-count";
  readonly cellEncoding: "row-major-lsb-first";
  readonly tilePathTemplate: "tiles/{z}/{x}/{y}.bin";
  readonly verification: {
    readonly canonicalDownloadVerified: true;
    readonly individualTileProofs: false;
  };
}

export interface LatestPointer {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly stateDigest: string;
  readonly manifestUrl: string;
  readonly sourceBlockHeight: string;
  readonly sourceBlockHash: string;
  readonly publishedAt: string;
}

export type EvidenceKind =
  | "metadata-observation"
  | "world-initialized-event"
  | "generation-advanced-event";

export interface LifeProvenance extends SnapshotIdentity {
  readonly schemaVersion: 1;
  readonly sourceBlockHeight: string;
  readonly sourceBlockHash: string;
  readonly evidenceKind: EvidenceKind;
  readonly transactionHash: string | null;
  readonly eventIndex: number | null;
  readonly eventKind: "WorldInitialized" | "GenerationAdvanced" | null;
  readonly requestId: string | null;
  readonly requester: string | null;
  readonly verifiedAt: string;
}

export interface PublishedIdentity {
  readonly generation: string;
  readonly stateDigest: string;
}

export interface LifeStatus {
  readonly schemaVersion: 1;
  readonly state: "idle" | "preparing" | "error";
  readonly observed: PublishedIdentity | null;
  readonly preparing:
    | (PublishedIdentity & {
        readonly completedUnits: number;
        readonly totalUnits: number;
        readonly unit: "chunks" | "tiles" | "files";
      })
    | null;
  readonly published: PublishedIdentity | null;
  readonly retry: { readonly attempt: number; readonly nextAt: string } | null;
  readonly errorCode: string | null;
  readonly heartbeatAt: string;
}

export interface CurrentWorldMetadata {
  readonly width: number;
  readonly height: number;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export function parseManifest(input: unknown): LifeManifest {
  const value = record(input, "manifest", [
    "schemaVersion",
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "width",
    "height",
    "population",
    "stateDigest",
    "tileSize",
    "maxZoom",
    "densityEncoding",
    "cellEncoding",
    "tilePathTemplate",
    "verification",
  ]);
  const verification = record(value.verification, "verification", [
    "canonicalDownloadVerified",
    "individualTileProofs",
  ]);
  literal(value.schemaVersion, 1, "schemaVersion");
  literal(value.width, WORLD_SIZE, "width");
  literal(value.height, WORLD_SIZE, "height");
  literal(value.tileSize, TILE_SIZE, "tileSize");
  literal(value.maxZoom, MAX_ZOOM, "maxZoom");
  literal(value.densityEncoding, "u16le-live-count", "densityEncoding");
  literal(value.cellEncoding, "row-major-lsb-first", "cellEncoding");
  literal(value.tilePathTemplate, "tiles/{z}/{x}/{y}.bin", "tilePathTemplate");
  literal(
    verification.canonicalDownloadVerified,
    true,
    "verification.canonicalDownloadVerified",
  );
  literal(
    verification.individualTileProofs,
    false,
    "verification.individualTileProofs",
  );
  const identity = parseIdentity(value);
  return {
    ...identity,
    schemaVersion: 1,
    width: 10_000,
    height: 10_000,
    tileSize: 256,
    maxZoom: 6,
    densityEncoding: "u16le-live-count",
    cellEncoding: "row-major-lsb-first",
    tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
    verification: {
      canonicalDownloadVerified: true,
      individualTileProofs: false,
    },
  };
}

export function parseLatest(
  input: unknown,
  networkId: string,
  contractAddress: string,
): LatestPointer {
  canonicalNetwork(networkId);
  canonicalHex32(contractAddress, "contractAddress");
  const value = record(input, "latest", [
    "schemaVersion",
    "generation",
    "stateDigest",
    "manifestUrl",
    "sourceBlockHeight",
    "sourceBlockHash",
    "publishedAt",
  ]);
  literal(value.schemaVersion, 1, "schemaVersion");
  const generation = decimal(value.generation, "generation");
  const stateDigest = canonicalHex32(value.stateDigest, "stateDigest");
  const expected = `/v1/worlds/${networkId}/${contractAddress}/${stateDigest}/manifest.json`;
  literal(value.manifestUrl, expected, "manifestUrl");
  return {
    schemaVersion: 1,
    generation,
    stateDigest,
    manifestUrl: expected,
    sourceBlockHeight: decimal(value.sourceBlockHeight, "sourceBlockHeight"),
    sourceBlockHash: canonicalHex32(value.sourceBlockHash, "sourceBlockHash"),
    publishedAt: date(value.publishedAt, "publishedAt"),
  };
}

export function parseProvenance(input: unknown): LifeProvenance {
  const value = record(input, "provenance", [
    "schemaVersion",
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "population",
    "stateDigest",
    "sourceBlockHeight",
    "sourceBlockHash",
    "evidenceKind",
    "transactionHash",
    "eventIndex",
    "eventKind",
    "requestId",
    "requester",
    "verifiedAt",
  ]);
  literal(value.schemaVersion, 1, "schemaVersion");
  const identity = parseIdentity(value);
  const evidenceKind = oneOf(
    value.evidenceKind,
    [
      "metadata-observation",
      "world-initialized-event",
      "generation-advanced-event",
    ] as const,
    "evidenceKind",
  );
  const transactionHash = nullableHex(value.transactionHash, "transactionHash");
  const eventIndex = nullableInteger(value.eventIndex, "eventIndex");
  const eventKind = nullableOneOf(
    value.eventKind,
    ["WorldInitialized", "GenerationAdvanced"] as const,
    "eventKind",
  );
  const requestId = nullableHex(value.requestId, "requestId");
  const requester = nullableHex(value.requester, "requester");
  if (evidenceKind === "metadata-observation") {
    requireAllNull(
      [transactionHash, eventIndex, eventKind, requestId, requester],
      "metadata evidence has event fields",
    );
  } else if (evidenceKind === "world-initialized-event") {
    if (
      identity.generation !== "0" ||
      transactionHash === null ||
      eventIndex === null ||
      eventKind !== "WorldInitialized" ||
      requestId !== null ||
      requester !== null
    ) {
      throw new SchemaError("WorldInitialized provenance fields disagree");
    }
  } else if (
    identity.generation === "0" ||
    transactionHash === null ||
    eventIndex === null ||
    eventKind !== "GenerationAdvanced" ||
    requestId === null ||
    requester === null
  ) {
    throw new SchemaError("GenerationAdvanced provenance fields disagree");
  }
  return {
    ...identity,
    schemaVersion: 1,
    sourceBlockHeight: decimal(value.sourceBlockHeight, "sourceBlockHeight"),
    sourceBlockHash: canonicalHex32(value.sourceBlockHash, "sourceBlockHash"),
    evidenceKind,
    transactionHash,
    eventIndex,
    eventKind,
    requestId,
    requester,
    verifiedAt: date(value.verifiedAt, "verifiedAt"),
  };
}

export function parseStatus(input: unknown): LifeStatus {
  const value = record(input, "status", [
    "schemaVersion",
    "state",
    "observed",
    "preparing",
    "published",
    "retry",
    "errorCode",
    "heartbeatAt",
  ]);
  literal(value.schemaVersion, 1, "schemaVersion");
  const state = oneOf(
    value.state,
    ["idle", "preparing", "error"] as const,
    "state",
  );
  const observed = nullableIdentity(value.observed, "observed");
  const published = nullableIdentity(value.published, "published");
  const preparingValue = nullableRecord(value.preparing, "preparing", [
    "generation",
    "stateDigest",
    "completedUnits",
    "totalUnits",
    "unit",
  ]);
  const preparing =
    preparingValue === null
      ? null
      : {
          ...parsePublished(preparingValue),
          completedUnits: positiveIntegerOrZero(
            preparingValue.completedUnits,
            "completedUnits",
          ),
          totalUnits: positiveInteger(preparingValue.totalUnits, "totalUnits"),
          unit: oneOf(
            preparingValue.unit,
            ["chunks", "tiles", "files"] as const,
            "unit",
          ),
        };
  if (preparing && preparing.completedUnits > preparing.totalUnits)
    throw new SchemaError("completedUnits exceeds totalUnits");
  const retryValue = nullableRecord(value.retry, "retry", [
    "attempt",
    "nextAt",
  ]);
  const retry =
    retryValue === null
      ? null
      : {
          attempt: positiveInteger(retryValue.attempt, "retry.attempt"),
          nextAt: date(retryValue.nextAt, "retry.nextAt"),
        };
  const errorCode =
    value.errorCode === null ? null : string(value.errorCode, "errorCode");
  if ((state === "preparing") !== (preparing !== null))
    throw new SchemaError("preparing must match state");
  if (
    (state === "error") !== (errorCode !== null) ||
    (errorCode !== null && !ERROR_CODE.test(errorCode))
  )
    throw new SchemaError("errorCode must match error state");
  return {
    schemaVersion: 1,
    state,
    observed,
    preparing,
    published,
    retry,
    errorCode,
    heartbeatAt: date(value.heartbeatAt, "heartbeatAt"),
  };
}

export function assertSnapshotAgreement(
  latest: LatestPointer,
  manifest: LifeManifest,
  provenance: LifeProvenance,
): void {
  const identityKeys = ["generation", "stateDigest"] as const;
  for (const key of identityKeys)
    if (latest[key] !== manifest[key])
      throw new SchemaError(`latest and manifest ${key} disagree`);
  const fullKeys = [
    "networkId",
    "contractAddress",
    "generation",
    "seed",
    "population",
    "stateDigest",
  ] as const;
  for (const key of fullKeys)
    if (manifest[key] !== provenance[key])
      throw new SchemaError(`manifest and provenance ${key} disagree`);
  if (
    latest.sourceBlockHeight !== provenance.sourceBlockHeight ||
    latest.sourceBlockHash !== provenance.sourceBlockHash
  ) {
    throw new SchemaError("latest and provenance source block disagree");
  }
}

export function assertSnapshotEligible(
  manifest: LifeManifest,
  provenance: LifeProvenance,
  current: CurrentWorldMetadata,
  scope: { readonly networkId: string; readonly contractAddress: string },
): void {
  if (
    manifest.networkId !== scope.networkId ||
    manifest.contractAddress !== scope.contractAddress
  )
    throw new SchemaError("snapshot is outside the configured world scope");
  const keys = [
    "width",
    "height",
    "generation",
    "seed",
    "population",
    "stateDigest",
  ] as const;
  for (const key of keys)
    if (manifest[key] !== current[key])
      throw new SchemaError(`snapshot and current chain ${key} disagree`);
  if (
    provenance.evidenceKind === "metadata-observation" &&
    (["generation", "seed", "population", "stateDigest"] as const).some(
      (key) => provenance[key] !== current[key],
    )
  )
    throw new SchemaError(
      "metadata observation does not describe current chain state",
    );
}

export function canonicalHex32(input: unknown, field = "identifier"): string {
  const value = string(input, field);
  if (!HEX32.test(value))
    throw new SchemaError(`${field} is not canonical lowercase hex32`);
  return value;
}

function parseIdentity(value: Record<string, unknown>): SnapshotIdentity {
  const population = decimal(value.population, "population");
  if (BigInt(population) > 100_000_000n)
    throw new SchemaError("population exceeds world capacity");
  return {
    networkId: canonicalNetwork(value.networkId),
    contractAddress: canonicalHex32(value.contractAddress, "contractAddress"),
    generation: decimal(value.generation, "generation"),
    seed: decimal(value.seed, "seed"),
    population,
    stateDigest: canonicalHex32(value.stateDigest, "stateDigest"),
  };
}

function canonicalNetwork(input: unknown): string {
  const value = string(input, "networkId");
  if (!NETWORK.test(value)) throw new SchemaError("networkId is not canonical");
  return value;
}
function decimal(input: unknown, field: string): string {
  const value = string(input, field);
  if (!DECIMAL.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)
    throw new SchemaError(`${field} is not canonical u64`);
  return value;
}
function date(input: unknown, field: string): string {
  const value = string(input, field);
  const parsed = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new SchemaError(`${field} is not a canonical UTC date`);
  return value;
}
function record(
  input: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new SchemaError(`${field} must be an object`);
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  )
    throw new SchemaError(`${field} has missing or unknown fields`);
  return value;
}
function nullableRecord(
  input: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  return input === null ? null : record(input, field, keys);
}
function string(input: unknown, field: string): string {
  if (typeof input !== "string")
    throw new SchemaError(`${field} must be a string`);
  return input;
}
function literal<T extends string | number | boolean>(
  input: unknown,
  expected: T,
  field: string,
): asserts input is T {
  if (input !== expected)
    throw new SchemaError(`${field} must be ${String(expected)}`);
}
function oneOf<const T extends readonly string[]>(
  input: unknown,
  values: T,
  field: string,
): T[number] {
  const value = string(input, field);
  if (!values.includes(value)) throw new SchemaError(`${field} is unsupported`);
  return value as T[number];
}
function nullableOneOf<const T extends readonly string[]>(
  input: unknown,
  values: T,
  field: string,
): T[number] | null {
  return input === null ? null : oneOf(input, values, field);
}
function nullableHex(input: unknown, field: string): string | null {
  return input === null ? null : canonicalHex32(input, field);
}
function nullableInteger(input: unknown, field: string): number | null {
  return input === null ? null : positiveIntegerOrZero(input, field);
}
function positiveInteger(input: unknown, field: string): number {
  const value = positiveIntegerOrZero(input, field);
  if (value === 0) throw new SchemaError(`${field} must be positive`);
  return value;
}
function positiveIntegerOrZero(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
    throw new SchemaError(`${field} must be a nonnegative safe integer`);
  return input;
}
function parsePublished(value: Record<string, unknown>): PublishedIdentity {
  return {
    generation: decimal(value.generation, "generation"),
    stateDigest: canonicalHex32(value.stateDigest, "stateDigest"),
  };
}
function nullableIdentity(
  input: unknown,
  field: string,
): PublishedIdentity | null {
  return input === null
    ? null
    : parsePublished(record(input, field, ["generation", "stateDigest"]));
}
function requireAllNull(values: readonly unknown[], message: string): void {
  if (values.some((value) => value !== null)) throw new SchemaError(message);
}
