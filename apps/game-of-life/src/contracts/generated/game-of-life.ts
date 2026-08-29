// Generated from game_of_life.spec.xdr - GameOfLife interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import {
  ContractTypeKind,
  ContractTypeDefKind,
  contractSpecString,
} from "@groundhogchain/contract-spec";
import {
  type ContractSpec,
  createContractCodecContext,
  defineContractMethod,
  type ContractException,
  type FixedBytes,
  defineContractEvent,
  type DecodedContractEvent,
  type ContractEventFilterValue,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  GameOfLife: {
    getCell: contractEntrypointID(fromHex("262db49c7562de71")),
    getChunk: contractEntrypointID(fromHex("5d130cba138a2fa2")),
    getMetadata: contractEntrypointID(fromHex("414af744a7b4d20c")),
    initialize: contractEntrypointID(fromHex("02788e24733cc45c")),
    processNextTick: contractEntrypointID(fromHex("715970538707ce84")),
    requestTick: contractEntrypointID(fromHex("abf7742c292ca352")),
  },
} as const;

export const GameOfLifeError = {
  AlreadyInitialized: 1n,
  NotInitialized: 2n,
  CoordinateOutOfBounds: 3n,
  ChunkOutOfBounds: 4n,
  GenerationOverflow: 5n,
  InvalidStoredState: 6n,
  InvalidQueueCapacity: 7n,
} as const;

export type GameOfLifeError =
  (typeof GameOfLifeError)[keyof typeof GameOfLifeError];

export interface TickResult {
  request_id: FixedBytes<32>;
  requested_by: ContractAddress;
  metadata: WorldMetadata;
}

export interface WorldMetadata {
  width: bigint;
  height: bigint;
  generation: bigint;
  seed: bigint;
  population: bigint;
  state_digest: FixedBytes<32>;
  chunk_bytes: bigint;
  chunks_per_row: bigint;
  max_queue_len: bigint;
}

export interface GameOfLifeGetCellArgs {
  x: bigint;
  y: bigint;
}
export type GameOfLifeGetCellResult = boolean;

export interface GameOfLifeGetChunkArgs {
  row: bigint;
  part: bigint;
}
export type GameOfLifeGetChunkResult = FixedBytes<1000>;

export type GameOfLifeGetMetadataArgs = void;
export type GameOfLifeGetMetadataResult = WorldMetadata;

export interface GameOfLifeInitializeArgs {
  seed: bigint;
  maxQueueLen: bigint;
}
export type GameOfLifeInitializeResult = WorldMetadata;

export type GameOfLifeProcessNextTickArgs = void;
export type GameOfLifeProcessNextTickResult = TickResult | null;

export type GameOfLifeRequestTickArgs = void;
export type GameOfLifeRequestTickResult = FixedBytes<32>;

export type GameOfLifeDeclaredException = {
  kind: "declared";
  name: "GameOfLifeError";
  selector: 0x63bf848a696f21bfn;
  value: GameOfLifeError;
};
export type GameOfLifeException =
  ContractException<GameOfLifeDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("GameOfLife"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          ty: { v: ContractTypeKind.Named, named: s("GameOfLifeError") },
        },
      ],
      methods: [
        {
          name: s("get_cell"),
          args: [
            { name: s("x"), ty: { v: ContractTypeKind.U32 } },
            { name: s("y"), ty: { v: ContractTypeKind.U32 } },
          ],
          return_type: { v: ContractTypeKind.Bool },
        },
        {
          name: s("get_chunk"),
          args: [
            { name: s("row"), ty: { v: ContractTypeKind.U32 } },
            { name: s("part"), ty: { v: ContractTypeKind.U32 } },
          ],
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 1000n },
          },
        },
        {
          name: s("get_metadata"),
          args: [],
          return_type: { v: ContractTypeKind.Named, named: s("WorldMetadata") },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("seed"), ty: { v: ContractTypeKind.U64 } },
            { name: s("max_queue_len"), ty: { v: ContractTypeKind.U32 } },
          ],
          return_type: { v: ContractTypeKind.Named, named: s("WorldMetadata") },
        },
        {
          name: s("process_next_tick"),
          args: [],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.Named, named: s("TickResult") },
          },
        },
        {
          name: s("request_tick"),
          args: [],
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
      ],
    },
  ],
  type_defs: [
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("GameOfLifeError"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("NotInitialized"), value: 2n },
          { name: s("CoordinateOutOfBounds"), value: 3n },
          { name: s("ChunkOutOfBounds"), value: 4n },
          { name: s("GenerationOverflow"), value: 5n },
          { name: s("InvalidStoredState"), value: 6n },
          { name: s("InvalidQueueCapacity"), value: 7n },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("TickResult"),
        fields: [
          {
            name: s("request_id"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          { name: s("requested_by"), ty: { v: ContractTypeKind.Address } },
          {
            name: s("metadata"),
            ty: { v: ContractTypeKind.Named, named: s("WorldMetadata") },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("WorldMetadata"),
        fields: [
          { name: s("width"), ty: { v: ContractTypeKind.U32 } },
          { name: s("height"), ty: { v: ContractTypeKind.U32 } },
          { name: s("generation"), ty: { v: ContractTypeKind.U64 } },
          { name: s("seed"), ty: { v: ContractTypeKind.U64 } },
          { name: s("population"), ty: { v: ContractTypeKind.U64 } },
          {
            name: s("state_digest"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          { name: s("chunk_bytes"), ty: { v: ContractTypeKind.U32 } },
          { name: s("chunks_per_row"), ty: { v: ContractTypeKind.U32 } },
          { name: s("max_queue_len"), ty: { v: ContractTypeKind.U32 } },
        ],
      },
    },
  ],
  events: [
    {
      name: s("GenerationAdvanced"),
      signature: topic(
        fromHex(
          "2657b6acef30bda5e51a6887b046b5cdae053ba640a9795786e0d727304128a6",
        ),
      ),
      topics: [
        {
          name: s("request_id"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
      ],
      fields: [
        { name: s("generation"), ty: { v: ContractTypeKind.U64 } },
        { name: s("requested_by"), ty: { v: ContractTypeKind.Address } },
        { name: s("population"), ty: { v: ContractTypeKind.U64 } },
        {
          name: s("state_digest"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
      ],
    },
    {
      name: s("TickRequested"),
      signature: topic(
        fromHex(
          "1aa07f416db4c821d936f47b626fb0bde1168442d6c384fc9f1aef75b93ada37",
        ),
      ),
      topics: [
        {
          name: s("request_id"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
        { name: s("requested_by"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [],
    },
    {
      name: s("WorldInitialized"),
      signature: topic(
        fromHex(
          "aeee0b8f32b14094ec3c214bd9415a7a99476144e3ae41db2a019b58d4ee55e0",
        ),
      ),
      topics: [],
      fields: [
        { name: s("seed"), ty: { v: ContractTypeKind.U64 } },
        { name: s("max_queue_len"), ty: { v: ContractTypeKind.U32 } },
        { name: s("population"), ty: { v: ContractTypeKind.U64 } },
        {
          name: s("state_digest"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
      ],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const GameOfLife = {
  getCell: defineContractMethod<
    GameOfLifeGetCellArgs,
    GameOfLifeGetCellResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.getCell,
    args: [
      {
        abiName: "x",
        publicName: "x",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
      {
        abiName: "y",
        publicName: "y",
        type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  getChunk: defineContractMethod<
    GameOfLifeGetChunkArgs,
    GameOfLifeGetChunkResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.getChunk,
    args: [
      {
        abiName: "row",
        publicName: "row",
        type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
      },
      {
        abiName: "part",
        publicName: "part",
        type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[1]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  getMetadata: defineContractMethod<
    GameOfLifeGetMetadataArgs,
    GameOfLifeGetMetadataResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.getMetadata,
    args: [],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    GameOfLifeInitializeArgs,
    GameOfLifeInitializeResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.initialize,
    args: [
      {
        abiName: "seed",
        publicName: "seed",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
      {
        abiName: "max_queue_len",
        publicName: "maxQueueLen",
        type: spec.interfaces[0]!.methods[3]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  processNextTick: defineContractMethod<
    GameOfLifeProcessNextTickArgs,
    GameOfLifeProcessNextTickResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.processNextTick,
    args: [],
    returnType: spec.interfaces[0]!.methods[4]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  requestTick: defineContractMethod<
    GameOfLifeRequestTickArgs,
    GameOfLifeRequestTickResult,
    GameOfLifeDeclaredException
  >({
    entrypoint: entrypoints.GameOfLife.requestTick,
    args: [],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
    throws: [
      {
        selector: 0x63bf848a696f21bfn,
        name: "GameOfLifeError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export interface GenerationAdvanced extends DecodedContractEvent<
  "GenerationAdvanced",
  { request_id: FixedBytes<32> },
  {
    generation: bigint;
    requested_by: ContractAddress;
    population: bigint;
    state_digest: FixedBytes<32>;
  }
> {}

export interface GenerationAdvancedFilter {
  request_id?: ContractEventFilterValue<FixedBytes<32>>;
}

export const GenerationAdvanced = defineContractEvent<
  "GenerationAdvanced",
  GenerationAdvanced["topics"],
  GenerationAdvanced["fields"],
  GenerationAdvancedFilter
>({
  name: "GenerationAdvanced",
  signature: spec.events[0]!.signature,
  topics: [
    {
      name: "request_id",
      type: spec.events[0]!.topics[0]!.ty,
      representation: "fixedBytes32",
    },
  ],
  fields: [
    { name: "generation", type: spec.events[0]!.fields[0]!.ty },
    { name: "requested_by", type: spec.events[0]!.fields[1]!.ty },
    { name: "population", type: spec.events[0]!.fields[2]!.ty },
    { name: "state_digest", type: spec.events[0]!.fields[3]!.ty },
  ],
  codecs,
});

export interface TickRequested extends DecodedContractEvent<
  "TickRequested",
  { request_id: FixedBytes<32>; requested_by: ContractAddress },
  {}
> {}

export interface TickRequestedFilter {
  request_id?: ContractEventFilterValue<FixedBytes<32>>;
  requested_by?: ContractEventFilterValue<ContractAddress>;
}

export const TickRequested = defineContractEvent<
  "TickRequested",
  TickRequested["topics"],
  TickRequested["fields"],
  TickRequestedFilter
>({
  name: "TickRequested",
  signature: spec.events[1]!.signature,
  topics: [
    {
      name: "request_id",
      type: spec.events[1]!.topics[0]!.ty,
      representation: "fixedBytes32",
    },
    {
      name: "requested_by",
      type: spec.events[1]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [],
  codecs,
});

export interface WorldInitialized extends DecodedContractEvent<
  "WorldInitialized",
  {},
  {
    seed: bigint;
    max_queue_len: bigint;
    population: bigint;
    state_digest: FixedBytes<32>;
  }
> {}

export type WorldInitializedFilter = Record<string, never>;

export const WorldInitialized = defineContractEvent<
  "WorldInitialized",
  WorldInitialized["topics"],
  WorldInitialized["fields"],
  WorldInitializedFilter
>({
  name: "WorldInitialized",
  signature: spec.events[2]!.signature,
  topics: [],
  fields: [
    { name: "seed", type: spec.events[2]!.fields[0]!.ty },
    { name: "max_queue_len", type: spec.events[2]!.fields[1]!.ty },
    { name: "population", type: spec.events[2]!.fields[2]!.ty },
    { name: "state_digest", type: spec.events[2]!.fields[3]!.ty },
  ],
  codecs,
});

export type GameOfLifeEvent =
  GenerationAdvanced | TickRequested | WorldInitialized;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): GameOfLifeEvent | null {
  return (
    GenerationAdvanced.decode(event) ??
    TickRequested.decode(event) ??
    WorldInitialized.decode(event)
  );
}
