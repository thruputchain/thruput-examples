// Generated from counter.spec.xdr - Counter interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  Counter: {
    v0_1: {
      decrement: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("048705b4b12f5264"),
      ),
      error: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("dcb12efadd026c01"),
      ),
      get: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("4a63f587ead25ca6"),
      ),
      increment: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("009cca8514f955ce"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("2bfe21a62e5119c4"),
      ),
      ping: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("1bdf2969df1758bd"),
      ),
    },
  },
} as const;

export namespace counter {
  export namespace v0_1 {
    export namespace implementation {
      export type CounterError = 1n;

      export interface PingEvent extends __gh_client_contract.DecodedContractEvent<
        "PingEvent",
        { tag: bigint },
        {}
      > {}

      export interface PingEventFilter {
        tag?: __gh_client_contract.ContractEventFilterValue<bigint>;
      }
    }
  }
}

export namespace Counter {
  export namespace v0_1 {
    export interface DecrementArgs {
      amount: bigint;
    }
    export type DecrementResult = void;

    export type ErrorArgs = void;
    export type ErrorResult = bigint;

    export type GetArgs = void;
    export type GetResult = bigint;

    export interface IncrementArgs {
      amount: bigint;
    }
    export type IncrementResult = void;

    export interface InitializeArgs {
      initialValue: bigint;
    }
    export type InitializeResult = void;

    export interface PingArgs {
      tag: bigint;
    }
    export type PingResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "CounterError";
      selector: 0xeb2cf72be75a4c62n;
      value: __gh_codegen.counter$v0_1$implementation$CounterError;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("Counter"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0xeb2cf72be75a4c62n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("counter"),
              major: __gh_s("0.1"),
              module_path: __gh_s("counter::implementation"),
              declared: __gh_s("CounterError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("decrement"),
          args: [
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("error"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("get"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: null,
        },
        {
          name: __gh_s("increment"),
          args: [
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("initial_value"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("ping"),
          args: [
            {
              name: __gh_s("tag"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("counter"),
          major: __gh_s("0.1"),
          module_path: __gh_s("counter::implementation"),
          declared: __gh_s("CounterError"),
        },
        variants: [{ name: __gh_s("NotAuthorized"), value: 1n }],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("counter"),
        major: __gh_s("0.1"),
        module_path: __gh_s("counter::implementation"),
        declared: __gh_s("PingEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "f0c8fa264c489d9d6bc8796daa7d6ab408d76b37ef41b6d6d951e20f63d10f52",
        ),
      ),
      topics: [
        {
          name: __gh_s("tag"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
      ],
      fields: [],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const Counter = {
  v0_1: {
    decrement: __gh_client_contract.defineContractMethod<
      Counter.v0_1.DecrementArgs,
      Counter.v0_1.DecrementResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "decrement",
      publicName: "decrement",
      entrypoint: __gh_entrypoints.Counter.v0_1.decrement,
      effect: spec.interfaces[0]!.methods[0]!.effect,
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
      codecs: __gh_codecs,
    }),
    error: __gh_client_contract.defineContractMethod<
      Counter.v0_1.ErrorArgs,
      Counter.v0_1.ErrorResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "error",
      publicName: "error",
      entrypoint: __gh_entrypoints.Counter.v0_1.error,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xeb2cf72be75a4c62n,
          name: "CounterError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    get: __gh_client_contract.defineContractMethod<
      Counter.v0_1.GetArgs,
      Counter.v0_1.GetResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "get",
      publicName: "get",
      entrypoint: __gh_entrypoints.Counter.v0_1.get,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xeb2cf72be75a4c62n,
          name: "CounterError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    increment: __gh_client_contract.defineContractMethod<
      Counter.v0_1.IncrementArgs,
      Counter.v0_1.IncrementResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "increment",
      publicName: "increment",
      entrypoint: __gh_entrypoints.Counter.v0_1.increment,
      effect: spec.interfaces[0]!.methods[3]!.effect,
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
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      Counter.v0_1.InitializeArgs,
      Counter.v0_1.InitializeResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.Counter.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[4]!.effect,
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
      codecs: __gh_codecs,
    }),
    ping: __gh_client_contract.defineContractMethod<
      Counter.v0_1.PingArgs,
      Counter.v0_1.PingResult,
      Counter.v0_1.DeclaredException
    >({
      interfaceName: "Counter",
      interfaceVersion: "0.1.0",
      abiName: "ping",
      publicName: "ping",
      entrypoint: __gh_entrypoints.Counter.v0_1.ping,
      effect: spec.interfaces[0]!.methods[5]!.effect,
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
      codecs: __gh_codecs,
    }),
  },
} as const;

export const counter = {
  v0_1: {
    implementation: {
      CounterError: {
        NotAuthorized: 1n,
      },
      PingEvent: __gh_client_contract.defineContractEvent<
        "PingEvent",
        counter.v0_1.implementation.PingEvent["topics"],
        counter.v0_1.implementation.PingEvent["fields"],
        counter.v0_1.implementation.PingEventFilter
      >({
        name: "PingEvent",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "tag",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "u64",
          },
        ],
        fields: [],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type CounterEvent = counter.v0_1.implementation.PingEvent;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): CounterEvent | null {
  return counter.v0_1.implementation.PingEvent.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type counter$v0_1$implementation$CounterError =
    counter.v0_1.implementation.CounterError;
}
