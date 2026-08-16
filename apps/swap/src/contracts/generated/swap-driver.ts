// Generated from swap_driver.spec.xdr - SwapDriver interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import {
  ContractTypeKind,
  ContractTypeDefKind,
  contractSpecString,
  ContractUnionCaseKind,
} from "@groundhogchain/contract-spec";
import {
  type ContractSpec,
  createContractCodecContext,
  defineContractMethod,
  type ContractAbort,
  type FixedBytes,
  defineContractEvent,
  type DecodedContractEvent,
  type ContractEventFilterValue,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  SwapDriver: {
    initialize: contractEntrypointID(fromHex("5141f296502fd167")),
    processRequests: contractEntrypointID(fromHex("4f3ee265487ea6e3")),
    request: contractEntrypointID(fromHex("1a3e665ef0730c72")),
  },
} as const;

export interface AddLiquidityRequest {
  purchaser: ContractAddress;
  amounts_desired: readonly [bigint, bigint];
  amounts_min: readonly [bigint, bigint];
  recipient: ContractAddress;
}

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

export interface RemoveLiquidityRequest {
  redeemer: ContractAddress;
  liquidity: bigint;
  amounts_min: readonly [bigint, bigint];
  recipient: ContractAddress;
}

export interface SwapExactInRequest {
  trader: ContractAddress;
  amount_in: bigint;
  amount_out_min: bigint;
  in_index: bigint;
  recipient: ContractAddress;
}

export interface SwapExactOutRequest {
  trader: ContractAddress;
  amount_out: bigint;
  amount_in_max: bigint;
  in_index: bigint;
  recipient: ContractAddress;
}

export const SwapLibraryError = {
  InsufficientAmount: 1n,
  InsufficientLiquidity: 2n,
  InsufficientInputAmount: 3n,
  InsufficientOutputAmount: 4n,
} as const;

export type SwapLibraryError =
  (typeof SwapLibraryError)[keyof typeof SwapLibraryError];

export type SwapOp =
  | { case: "AddLiquidity"; value: readonly [AddLiquidityRequest] }
  | { case: "RemoveLiquidity"; value: readonly [RemoveLiquidityRequest] }
  | { case: "SwapExactIn"; value: readonly [SwapExactInRequest] }
  | { case: "SwapExactOut"; value: readonly [SwapExactOutRequest] };

export type SwapPairError =
  | { case: "InitializeFailed" }
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
  | { case: "LPTokenFailure"; value: readonly [ERC20Error] };

export interface SwapRequest {
  request_id: FixedBytes<32>;
  op: SwapOp;
}

export const SwapRequestError = {
  InsufficientAmountA: 1n,
  InsufficientAmountB: 2n,
  InsufficientOutputAmount: 3n,
  ExcessiveInputAmount: 4n,
} as const;

export type SwapRequestError =
  (typeof SwapRequestError)[keyof typeof SwapRequestError];

export interface SwapDriverInitializeArgs {
  handler: ContractAddress;
}
export type SwapDriverInitializeResult = void;

export type SwapDriverProcessRequestsArgs = void;
export type SwapDriverProcessRequestsResult = readonly [bigint, bigint];

export interface SwapDriverRequestArgs {
  request: SwapRequest;
}
export type SwapDriverRequestResult = FixedBytes<32>;

export type SwapDriverDeclaredAbort =
  | {
      kind: "declared";
      exception: "SwapLibraryError";
      selector: 0x17e7e152700d9279n;
      value: SwapLibraryError;
    }
  | {
      kind: "declared";
      exception: "SwapPairError";
      selector: 0x25d002d47b07640dn;
      value: SwapPairError;
    }
  | {
      kind: "declared";
      exception: "SwapRequestError";
      selector: 0x947bdd51feea1ccen;
      value: SwapRequestError;
    }
  | {
      kind: "declared";
      exception: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: ERC20Error;
    };
export type SwapDriverAbort = ContractAbort<SwapDriverDeclaredAbort>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapDriver"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0x17e7e152700d9279n,
          ty: { v: ContractTypeKind.Named, named: s("SwapLibraryError") },
        },
        {
          selector: 0x25d002d47b07640dn,
          ty: { v: ContractTypeKind.Named, named: s("SwapPairError") },
        },
        {
          selector: 0x947bdd51feea1ccen,
          ty: { v: ContractTypeKind.Named, named: s("SwapRequestError") },
        },
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
      ],
      methods: [
        {
          name: s("initialize"),
          args: [{ name: s("handler"), ty: { v: ContractTypeKind.Address } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("process_requests"),
          args: [],
          return_type: {
            v: ContractTypeKind.Tuple,
            tuple: [{ v: ContractTypeKind.U32 }, { v: ContractTypeKind.U32 }],
          },
        },
        {
          name: s("request"),
          args: [
            {
              name: s("request"),
              ty: { v: ContractTypeKind.Named, named: s("SwapRequest") },
            },
          ],
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
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("AddLiquidityRequest"),
        fields: [
          { name: s("purchaser"), ty: { v: ContractTypeKind.Address } },
          {
            name: s("amounts_desired"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U128 }, len: 2n },
            },
          },
          {
            name: s("amounts_min"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U128 }, len: 2n },
            },
          },
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
          {
            name: s("amounts_min"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U128 }, len: 2n },
            },
          },
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
            case_type: {
              v: ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                { v: ContractTypeKind.Named, named: s("AddLiquidityRequest") },
              ],
            },
          },
          {
            name: s("RemoveLiquidity"),
            discriminant: 2n,
            case_type: {
              v: ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: ContractTypeKind.Named,
                  named: s("RemoveLiquidityRequest"),
                },
              ],
            },
          },
          {
            name: s("SwapExactIn"),
            discriminant: 3n,
            case_type: {
              v: ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                { v: ContractTypeKind.Named, named: s("SwapExactInRequest") },
              ],
            },
          },
          {
            name: s("SwapExactOut"),
            discriminant: 4n,
            case_type: {
              v: ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                { v: ContractTypeKind.Named, named: s("SwapExactOutRequest") },
              ],
            },
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
            case_type: {
              v: ContractUnionCaseKind.UnionCaseTuple,
              tuple: [{ v: ContractTypeKind.Named, named: s("ERC20Error") }],
            },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("SwapRequest"),
        fields: [
          {
            name: s("request_id"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          {
            name: s("op"),
            ty: { v: ContractTypeKind.Named, named: s("SwapOp") },
          },
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
      signature: topic(
        fromHex(
          "adda27e0abdb0cc3b49c16a060fdc703aadcdeedf34701de90b60aeb525d37fc",
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
      fields: [],
    },
    {
      name: s("RequestFailed"),
      signature: topic(
        fromHex(
          "ef544a357e3cb94130fce15a57fb417430e08c359db240ed02e57902f374c21a",
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
      fields: [],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const SwapDriver = {
  initialize: defineContractMethod<
    SwapDriverInitializeArgs,
    SwapDriverInitializeResult,
    SwapDriverDeclaredAbort
  >({
    entrypoint: entrypoints.SwapDriver.initialize,
    args: [
      {
        abiName: "handler",
        publicName: "handler",
        type: spec.interfaces[0].methods[0].args[0].ty,
      },
    ],
    returnType: spec.interfaces[0].methods[0].return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        exception: "SwapLibraryError",
        type: spec.interfaces[0].throws[0].ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0].throws[1].ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        exception: "SwapRequestError",
        type: spec.interfaces[0].throws[2].ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0].throws[3].ty,
      },
    ],
    codecs,
  }),
  processRequests: defineContractMethod<
    SwapDriverProcessRequestsArgs,
    SwapDriverProcessRequestsResult,
    SwapDriverDeclaredAbort
  >({
    entrypoint: entrypoints.SwapDriver.processRequests,
    args: [],
    returnType: spec.interfaces[0].methods[1].return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        exception: "SwapLibraryError",
        type: spec.interfaces[0].throws[0].ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0].throws[1].ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        exception: "SwapRequestError",
        type: spec.interfaces[0].throws[2].ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0].throws[3].ty,
      },
    ],
    codecs,
  }),
  request: defineContractMethod<
    SwapDriverRequestArgs,
    SwapDriverRequestResult,
    SwapDriverDeclaredAbort
  >({
    entrypoint: entrypoints.SwapDriver.request,
    args: [
      {
        abiName: "request",
        publicName: "request",
        type: spec.interfaces[0].methods[2].args[0].ty,
      },
    ],
    returnType: spec.interfaces[0].methods[2].return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        exception: "SwapLibraryError",
        type: spec.interfaces[0].throws[0].ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0].throws[1].ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        exception: "SwapRequestError",
        type: spec.interfaces[0].throws[2].ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0].throws[3].ty,
      },
    ],
    codecs,
  }),
} as const;

export interface RequestAccepted extends DecodedContractEvent<
  "RequestAccepted",
  { request_id: FixedBytes<32> },
  {}
> {}

export interface RequestAcceptedFilter {
  request_id?: ContractEventFilterValue<FixedBytes<32>>;
}

export const RequestAccepted = defineContractEvent<
  "RequestAccepted",
  RequestAccepted["topics"],
  RequestAccepted["fields"],
  RequestAcceptedFilter
>({
  name: "RequestAccepted",
  signature: spec.events[0].signature,
  topics: [
    {
      name: "request_id",
      type: spec.events[0].topics[0].ty,
      representation: "fixedBytes32",
    },
  ],
  fields: [],
  codecs,
});

export interface RequestFailed extends DecodedContractEvent<
  "RequestFailed",
  { request_id: FixedBytes<32> },
  {}
> {}

export interface RequestFailedFilter {
  request_id?: ContractEventFilterValue<FixedBytes<32>>;
}

export const RequestFailed = defineContractEvent<
  "RequestFailed",
  RequestFailed["topics"],
  RequestFailed["fields"],
  RequestFailedFilter
>({
  name: "RequestFailed",
  signature: spec.events[1].signature,
  topics: [
    {
      name: "request_id",
      type: spec.events[1].topics[0].ty,
      representation: "fixedBytes32",
    },
  ],
  fields: [],
  codecs,
});

export type SwapDriverEvent = RequestAccepted | RequestFailed;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapDriverEvent | null {
  return RequestAccepted.decode(event) ?? RequestFailed.decode(event);
}
