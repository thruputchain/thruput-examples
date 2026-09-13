// Generated from counter.spec.xdr - Counter interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

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
  defineContractEvent,
  type DecodedContractEvent,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  Counter: {
    decrement: contractEntrypointID(fromHex("048705b4b12f5264")),
    error: contractEntrypointID(fromHex("dcb12efadd026c01")),
    get: contractEntrypointID(fromHex("4a63f587ead25ca6")),
    increment: contractEntrypointID(fromHex("009cca8514f955ce")),
    initialize: contractEntrypointID(fromHex("2bfe21a62e5119c4")),
    ping: contractEntrypointID(fromHex("1bdf2969df1758bd")),
  },
} as const;

export const CounterError = { NotAuthorized: 1n } as const;

export type CounterError = (typeof CounterError)[keyof typeof CounterError];

export interface CounterDecrementArgs {
  amount: bigint;
}
export type CounterDecrementResult = void;

export type CounterErrorArgs = void;
export type CounterErrorResult = bigint;

export type CounterGetArgs = void;
export type CounterGetResult = bigint;

export interface CounterIncrementArgs {
  amount: bigint;
}
export type CounterIncrementResult = void;

export interface CounterInitializeArgs {
  initialValue: bigint;
}
export type CounterInitializeResult = void;

export interface CounterPingArgs {
  tag: bigint;
}
export type CounterPingResult = void;

export type CounterDeclaredException = {
  kind: "declared";
  name: "CounterError";
  selector: 0xeb2cf72be75a4c62n;
  value: CounterError;
};
export type CounterException = ContractException<CounterDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("Counter"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0xeb2cf72be75a4c62n,
          ty: { v: ContractTypeKind.Named, named: s("CounterError") },
        },
      ],
      methods: [
        {
          name: s("decrement"),
          args: [{ name: s("amount"), ty: { v: ContractTypeKind.U64 } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("error"),
          args: [],
          return_type: { v: ContractTypeKind.U64 },
        },
        {
          name: s("get"),
          args: [],
          return_type: { v: ContractTypeKind.U64 },
        },
        {
          name: s("increment"),
          args: [{ name: s("amount"), ty: { v: ContractTypeKind.U64 } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("initialize"),
          args: [{ name: s("initial_value"), ty: { v: ContractTypeKind.U64 } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("ping"),
          args: [{ name: s("tag"), ty: { v: ContractTypeKind.U64 } }],
          return_type: { v: ContractTypeKind.Void },
        },
      ],
    },
  ],
  type_defs: [
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("CounterError"),
        variants: [{ name: s("NotAuthorized"), value: 1n }],
      },
    },
  ],
  events: [
    {
      name: s("PingEvent"),
      signature: topic(
        fromHex(
          "f0c8fa264c489d9d6bc8796daa7d6ab408d76b37ef41b6d6d951e20f63d10f52",
        ),
      ),
      topics: [{ name: s("tag"), ty: { v: ContractTypeKind.U64 } }],
      fields: [],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const Counter = {
  decrement: defineContractMethod<
    CounterDecrementArgs,
    CounterDecrementResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.decrement,
    args: [
      {
        abiName: "amount",
        publicName: "amount",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  error: defineContractMethod<
    CounterErrorArgs,
    CounterErrorResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.error,
    args: [],
    returnType: spec.interfaces[0]!.methods[1]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  get: defineContractMethod<
    CounterGetArgs,
    CounterGetResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.get,
    args: [],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  increment: defineContractMethod<
    CounterIncrementArgs,
    CounterIncrementResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.increment,
    args: [
      {
        abiName: "amount",
        publicName: "amount",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    CounterInitializeArgs,
    CounterInitializeResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.initialize,
    args: [
      {
        abiName: "initial_value",
        publicName: "initialValue",
        type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[4]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  ping: defineContractMethod<
    CounterPingArgs,
    CounterPingResult,
    CounterDeclaredException
  >({
    entrypoint: entrypoints.Counter.ping,
    args: [
      {
        abiName: "tag",
        publicName: "tag",
        type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
    throws: [
      {
        selector: 0xeb2cf72be75a4c62n,
        name: "CounterError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export interface PingEvent extends DecodedContractEvent<
  "PingEvent",
  { tag: Uint8Array },
  {}
> {}

export type PingEventFilter = Record<string, never>;

export const PingEvent = defineContractEvent<
  "PingEvent",
  PingEvent["topics"],
  PingEvent["fields"],
  PingEventFilter
>({
  name: "PingEvent",
  signature: spec.events[0]!.signature,
  topics: [
    {
      name: "tag",
      type: spec.events[0]!.topics[0]!.ty,
      representation: "hash",
    },
  ],
  fields: [],
  codecs,
});

export type CounterEvent = PingEvent;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): CounterEvent | null {
  return PingEvent.decode(event);
}
