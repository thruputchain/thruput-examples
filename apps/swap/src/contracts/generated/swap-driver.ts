// Generated from swap_driver.spec.xdr — SwapDriver interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress, GasAmount, Invocation } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import { ContractTypeKind, ContractTypeDefKind, contractSpecString, ContractUnionCaseKind } from "@groundhogchain/contract-spec";
import type { ContractSpec } from "@groundhogchain/client";
import { encodeCalldata } from "@groundhogchain/client";
import { buildNamedCodecs } from "@groundhogchain/client";
import { createInvocation } from "@groundhogchain/client";
import { resolveCodec } from "@groundhogchain/client";
import { CxsReader } from "@groundhogchain/xdr";

const s = contractSpecString;

const entrypoints = {
  SwapDriver: {
    initialize: contractEntrypointID(fromHex("5141f296502fd167")),
    processRequests: contractEntrypointID(fromHex("4f3ee265487ea6e3")),
    request: contractEntrypointID(fromHex("1a3e665ef0730c72")),
  },
} as const;

export interface AddLiquidityRequest { purchaser: ContractAddress; amounts_desired: bigint[]; amounts_min: bigint[]; recipient: ContractAddress; }

export enum ERC20Error { AlreadyInitialized = 1, MustBeContractOwner = 2, TooLarge = 3, Internal = 100, }

export interface RemoveLiquidityRequest { redeemer: ContractAddress; liquidity: bigint; amounts_min: bigint[]; recipient: ContractAddress; }

export interface SwapExactInRequest { trader: ContractAddress; amount_in: bigint; amount_out_min: bigint; in_index: bigint; recipient: ContractAddress; }

export interface SwapExactOutRequest { trader: ContractAddress; amount_out: bigint; amount_in_max: bigint; in_index: bigint; recipient: ContractAddress; }

export enum SwapLibraryError { InsufficientAmount = 1, InsufficientLiquidity = 2, InsufficientInputAmount = 3, InsufficientOutputAmount = 4, }

export type SwapOp =
  { case: "AddLiquidity"; value: [AddLiquidityRequest] }
  | { case: "RemoveLiquidity"; value: [RemoveLiquidityRequest] }
  | { case: "SwapExactIn"; value: [SwapExactInRequest] }
  | { case: "SwapExactOut"; value: [SwapExactOutRequest] };

export type SwapPairError =
  { case: "InitializeFailed" }
  | { case: "AlreadyInitialized" }
  | { case: "NoLiquidityToBurn" }
  | { case: "InsufficientOutputAmount" }
  | { case: "InsufficientInputAmount" }
  | { case: "InsufficientLiquidity" }
  | { case: "InsufficientLiquidityMinted" }
  | { case: "InsufficientLiquidityBurned" }
  | { case: "InvalidDestination" }
  | { case: "InvalidSwapProduct" }
  | { case: "Overflow" }
  | { case: "TransferFailed" }
  | { case: "LPTokenFailure"; value: [ERC20Error] };

export interface SwapRequest { request_id: Uint8Array; op: SwapOp; }

export enum SwapRequestError { InsufficientAmountA = 1, InsufficientAmountB = 2, InsufficientOutputAmount = 3, ExcessiveInputAmount = 4, }

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapDriver"),
      vers: s("0.1.0"),
      throws: [
        { selector: 0x17e7e152700d9279n, ty: { v: ContractTypeKind.Named, named: s("SwapLibraryError") } },
        { selector: 0x25d002d47b07640dn, ty: { v: ContractTypeKind.Named, named: s("SwapPairError") } },
        { selector: 0x947bdd51feea1ccen, ty: { v: ContractTypeKind.Named, named: s("SwapRequestError") } },
        { selector: 0xb19947acb2fa14ffn, ty: { v: ContractTypeKind.Named, named: s("ERC20Error") } },
      ],
      methods: [
        {
          name: s("initialize"),
          args: [
            { name: s("handler"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("process_requests"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Tuple, tuple: [{ v: ContractTypeKind.U32 }, { v: ContractTypeKind.U32 }] },
        },
        {
          name: s("request"),
          args: [
            { name: s("request"), ty: { v: ContractTypeKind.Named, named: s("SwapRequest") } },
          ],
          return_type: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } },
        },
      ],
    },
  ],
  type_defs: [
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("AddLiquidityRequest"),
        fields: [
          { name: s("purchaser"), ty: { v: ContractTypeKind.Address } },
          { name: s("amounts_desired"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
          { name: s("amounts_min"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
          { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("ERC20Error"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("MustBeContractOwner"), value: 2n },
          { name: s("TooLarge"), value: 3n },
          { name: s("Internal"), value: 100n },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("RemoveLiquidityRequest"),
        fields: [
          { name: s("redeemer"), ty: { v: ContractTypeKind.Address } },
          { name: s("liquidity"), ty: { v: ContractTypeKind.U128 } },
          { name: s("amounts_min"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
          { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("SwapExactInRequest"),
        fields: [
          { name: s("trader"), ty: { v: ContractTypeKind.Address } },
          { name: s("amount_in"), ty: { v: ContractTypeKind.U128 } },
          { name: s("amount_out_min"), ty: { v: ContractTypeKind.U128 } },
          { name: s("in_index"), ty: { v: ContractTypeKind.U32 } },
          { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("SwapExactOutRequest"),
        fields: [
          { name: s("trader"), ty: { v: ContractTypeKind.Address } },
          { name: s("amount_out"), ty: { v: ContractTypeKind.U128 } },
          { name: s("amount_in_max"), ty: { v: ContractTypeKind.U128 } },
          { name: s("in_index"), ty: { v: ContractTypeKind.U32 } },
          { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapLibraryError"),
        variants: [
          { name: s("InsufficientAmount"), value: 1n },
          { name: s("InsufficientLiquidity"), value: 2n },
          { name: s("InsufficientInputAmount"), value: 3n },
          { name: s("InsufficientOutputAmount"), value: 4n },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefUnion,
      union_def: {
        name: s("SwapOp"),
        cases: [
          {
            name: s("AddLiquidity"),
            discriminant: 1n,
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("AddLiquidityRequest") }] },
          },
          {
            name: s("RemoveLiquidity"),
            discriminant: 2n,
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("RemoveLiquidityRequest") }] },
          },
          {
            name: s("SwapExactIn"),
            discriminant: 3n,
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("SwapExactInRequest") }] },
          },
          {
            name: s("SwapExactOut"),
            discriminant: 4n,
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("SwapExactOutRequest") }] },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefUnion,
      union_def: {
        name: s("SwapPairError"),
        cases: [
          {
            name: s("InitializeFailed"),
            discriminant: 1n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("AlreadyInitialized"),
            discriminant: 2n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("NoLiquidityToBurn"),
            discriminant: 3n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InsufficientOutputAmount"),
            discriminant: 4n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InsufficientInputAmount"),
            discriminant: 5n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InsufficientLiquidity"),
            discriminant: 6n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InsufficientLiquidityMinted"),
            discriminant: 7n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InsufficientLiquidityBurned"),
            discriminant: 8n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InvalidDestination"),
            discriminant: 9n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("InvalidSwapProduct"),
            discriminant: 10n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("Overflow"),
            discriminant: 11n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("TransferFailed"),
            discriminant: 12n,
            case_type: { v: ContractUnionCaseKind.UnionCaseVoid },
          },
          {
            name: s("LPTokenFailure"),
            discriminant: 13n,
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("ERC20Error") }] },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("SwapRequest"),
        fields: [
          { name: s("request_id"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
          { name: s("op"), ty: { v: ContractTypeKind.Named, named: s("SwapOp") } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapRequestError"),
        variants: [
          { name: s("InsufficientAmountA"), value: 1n },
          { name: s("InsufficientAmountB"), value: 2n },
          { name: s("InsufficientOutputAmount"), value: 3n },
          { name: s("ExcessiveInputAmount"), value: 4n },
        ],
      },
    },
  ],
  events: [
    {
      name: s("RequestAccepted"),
      signature: topic(fromHex("adda27e0abdb0cc3b49c16a060fdc703aadcdeedf34701de90b60aeb525d37fc")),
      topics: [
        { name: s("request_id"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
      ],
      fields: [
      ],
    },
    {
      name: s("RequestFailed"),
      signature: topic(fromHex("ef544a357e3cb94130fce15a57fb417430e08c359db240ed02e57902f374c21a")),
      topics: [
        { name: s("request_id"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } },
      ],
      fields: [
      ],
    },
  ],
};

const namedCodecs = buildNamedCodecs(spec.type_defs);

export const SwapDriver = {
  initialize(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { handler: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapDriver.initialize,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapDriver", "initialize", [args.handler], namedCodecs),
    });
  },
  processRequests(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapDriver.processRequests,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapDriver", "process_requests", [], namedCodecs),
    });
  },
  request(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { request: SwapRequest },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapDriver.request,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapDriver", "request", [args.request], namedCodecs),
    });
  },
} as const;

function topicEquals(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface RequestAccepted {
  name: "RequestAccepted";
  topics: { request_id: Uint8Array; };
  fields: {  };
}
export const RequestAccepted = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("adda27e0abdb0cc3b49c16a060fdc703aadcdeedf34701de90b60aeb525d37fc"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): RequestAccepted | null {
    if (!topicEquals(event.topics[0], RequestAccepted.signature)) return null;
    if (event.topics.length !== 2) {
      throw new Error(`RequestAccepted: expected 2 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    if (r.remaining !== 0) {
      throw new Error(`RequestAccepted: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "RequestAccepted", topics: { request_id: event.topics[1] }, fields: {  } };
  },
} as const;

export interface RequestFailed {
  name: "RequestFailed";
  topics: { request_id: Uint8Array; };
  fields: {  };
}
export const RequestFailed = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("ef544a357e3cb94130fce15a57fb417430e08c359db240ed02e57902f374c21a"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): RequestFailed | null {
    if (!topicEquals(event.topics[0], RequestFailed.signature)) return null;
    if (event.topics.length !== 2) {
      throw new Error(`RequestFailed: expected 2 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    if (r.remaining !== 0) {
      throw new Error(`RequestFailed: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "RequestFailed", topics: { request_id: event.topics[1] }, fields: {  } };
  },
} as const;

export type SwapDriverEvent = RequestAccepted | RequestFailed;

export function decodeEvent(event: { topics: Uint8Array[]; data: Uint8Array }): SwapDriverEvent | null {
  return RequestAccepted.decode(event) ?? RequestFailed.decode(event);
}
