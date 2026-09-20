// Generated from swap_handler.spec.xdr - SwapHandler interface v0.1.0
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
  type ContractException,
  type FixedBytes,
  defineContractEvent,
  type DecodedContractEvent,
  type ContractEventFilterValue,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  SwapHandler: {
    handleRequest: contractEntrypointID(fromHex("45c30c0e5c3ad2b1")),
    initialize: contractEntrypointID(fromHex("666b73d370c19654")),
    poolState: contractEntrypointID(fromHex("99df53a24d53d371")),
    skim: contractEntrypointID(fromHex("96e630c21054936f")),
    sync: contractEntrypointID(fromHex("03338c16cd55a918")),
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

export interface PoolState {
  reserves: readonly [bigint, bigint];
  block_timestamp: bigint;
  liquidity: bigint;
  liquidity_token: ContractAddress;
  cumulative_prices: readonly [bigint, bigint];
}

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
  Unauthorized: 100n,
  InsufficientAmountA: 1n,
  InsufficientAmountB: 2n,
  InsufficientOutputAmount: 3n,
  ExcessiveInputAmount: 4n,
} as const;

export type SwapRequestError =
  (typeof SwapRequestError)[keyof typeof SwapRequestError];

export interface SwapHandlerHandleRequestArgs {
  request: SwapRequest;
}
export type SwapHandlerHandleRequestResult = void;

export interface SwapHandlerInitializeArgs {
  factory: ContractAddress;
  token0: ContractAddress;
  token1: ContractAddress;
  lpToken: ContractAddress;
  driver: ContractAddress;
}
export type SwapHandlerInitializeResult = void;

export type SwapHandlerPoolStateArgs = void;
export type SwapHandlerPoolStateResult = PoolState;

export interface SwapHandlerSkimArgs {
  to: ContractAddress;
}
export type SwapHandlerSkimResult = void;

export type SwapHandlerSyncArgs = void;
export type SwapHandlerSyncResult = void;

export type SwapHandlerDeclaredException =
  | {
      kind: "declared";
      name: "SwapLibraryError";
      selector: 0x17e7e152700d9279n;
      value: SwapLibraryError;
    }
  | {
      kind: "declared";
      name: "SwapPairError";
      selector: 0x25d002d47b07640dn;
      value: SwapPairError;
    }
  | {
      kind: "declared";
      name: "SwapRequestError";
      selector: 0x947bdd51feea1ccen;
      value: SwapRequestError;
    }
  | {
      kind: "declared";
      name: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: ERC20Error;
    };
export type SwapHandlerException =
  ContractException<SwapHandlerDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapHandler"),
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
          name: s("handle_request"),
          args: [
            {
              name: s("request"),
              ty: { v: ContractTypeKind.Named, named: s("SwapRequest") },
            },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("factory"), ty: { v: ContractTypeKind.Address } },
            { name: s("token0"), ty: { v: ContractTypeKind.Address } },
            { name: s("token1"), ty: { v: ContractTypeKind.Address } },
            { name: s("lp_token"), ty: { v: ContractTypeKind.Address } },
            { name: s("driver"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("pool_state"),
          args: [],
          return_type: { v: ContractTypeKind.Named, named: s("PoolState") },
        },
        {
          name: s("skim"),
          args: [{ name: s("to"), ty: { v: ContractTypeKind.Address } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("sync"),
          args: [],
          return_type: { v: ContractTypeKind.Void },
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
        name: s("PoolState"),
        fields: [
          {
            name: s("reserves"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U128 }, len: 2n },
            },
          },
          { name: s("block_timestamp"), ty: { v: ContractTypeKind.U32 } },
          { name: s("liquidity"), ty: { v: ContractTypeKind.U128 } },
          { name: s("liquidity_token"), ty: { v: ContractTypeKind.Address } },
          {
            name: s("cumulative_prices"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U256 }, len: 2n },
            },
          },
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
          { name: s("Unauthorized"), value: 100n },
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
      name: s("LiquidityBurnEvent"),
      signature: topic(
        fromHex(
          "3c2f1654cb81e61936b5544fd2ddec7c1ae881b4f6eca293cd21d0f3e5b999a3",
        ),
      ),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        {
          name: s("amounts_redeemed"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U128 }, len: 2n },
          },
        },
        {
          name: s("request_id"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
        },
      ],
    },
    {
      name: s("LiquidityMintEvent"),
      signature: topic(
        fromHex(
          "972c26dc446a644066cd50d95bc7523ce1dd815f505dfc28cba88e00bcc771a7",
        ),
      ),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("amount_minted"), ty: { v: ContractTypeKind.U128 } },
        {
          name: s("request_id"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
        },
      ],
    },
    {
      name: s("SwapEvent"),
      signature: topic(
        fromHex(
          "86b5aa1c9e00134a5f67a0206b1212775022c4ab4b5099e70602e5c1548a19ab",
        ),
      ),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        {
          name: s("amounts_in"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U128 }, len: 2n },
          },
        },
        {
          name: s("amounts_out"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U128 }, len: 2n },
          },
        },
        {
          name: s("request_id"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
        },
      ],
    },
    {
      name: s("SyncEvent"),
      signature: topic(
        fromHex(
          "15f9dd3052c289e08cbcd724168d985fe851ce3991f43b095f5b70d3a292d4bd",
        ),
      ),
      topics: [],
      fields: [
        {
          name: s("reserves"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U128 }, len: 2n },
          },
        },
      ],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const SwapHandler = {
  handleRequest: defineContractMethod<
    SwapHandlerHandleRequestArgs,
    SwapHandlerHandleRequestResult,
    SwapHandlerDeclaredException
  >({
    interfaceName: "SwapHandler",
    interfaceVersion: "0.1.0",
    abiName: "handle_request",
    publicName: "handleRequest",
    entrypoint: entrypoints.SwapHandler.handleRequest,
    args: [
      {
        abiName: "request",
        publicName: "request",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        name: "SwapLibraryError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        name: "SwapPairError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    SwapHandlerInitializeArgs,
    SwapHandlerInitializeResult,
    SwapHandlerDeclaredException
  >({
    interfaceName: "SwapHandler",
    interfaceVersion: "0.1.0",
    abiName: "initialize",
    publicName: "initialize",
    entrypoint: entrypoints.SwapHandler.initialize,
    args: [
      {
        abiName: "factory",
        publicName: "factory",
        type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
      },
      {
        abiName: "token0",
        publicName: "token0",
        type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
      },
      {
        abiName: "token1",
        publicName: "token1",
        type: spec.interfaces[0]!.methods[1]!.args[2]!.ty,
      },
      {
        abiName: "lp_token",
        publicName: "lpToken",
        type: spec.interfaces[0]!.methods[1]!.args[3]!.ty,
      },
      {
        abiName: "driver",
        publicName: "driver",
        type: spec.interfaces[0]!.methods[1]!.args[4]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[1]!.return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        name: "SwapLibraryError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        name: "SwapPairError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
    ],
    codecs,
  }),
  poolState: defineContractMethod<
    SwapHandlerPoolStateArgs,
    SwapHandlerPoolStateResult,
    SwapHandlerDeclaredException
  >({
    interfaceName: "SwapHandler",
    interfaceVersion: "0.1.0",
    abiName: "pool_state",
    publicName: "poolState",
    entrypoint: entrypoints.SwapHandler.poolState,
    args: [],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        name: "SwapLibraryError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        name: "SwapPairError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
    ],
    codecs,
  }),
  skim: defineContractMethod<
    SwapHandlerSkimArgs,
    SwapHandlerSkimResult,
    SwapHandlerDeclaredException
  >({
    interfaceName: "SwapHandler",
    interfaceVersion: "0.1.0",
    abiName: "skim",
    publicName: "skim",
    entrypoint: entrypoints.SwapHandler.skim,
    args: [
      {
        abiName: "to",
        publicName: "to",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        name: "SwapLibraryError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        name: "SwapPairError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
    ],
    codecs,
  }),
  sync: defineContractMethod<
    SwapHandlerSyncArgs,
    SwapHandlerSyncResult,
    SwapHandlerDeclaredException
  >({
    interfaceName: "SwapHandler",
    interfaceVersion: "0.1.0",
    abiName: "sync",
    publicName: "sync",
    entrypoint: entrypoints.SwapHandler.sync,
    args: [],
    returnType: spec.interfaces[0]!.methods[4]!.return_type,
    throws: [
      {
        selector: 0x17e7e152700d9279n,
        name: "SwapLibraryError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0x25d002d47b07640dn,
        name: "SwapPairError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export interface LiquidityBurnEvent extends DecodedContractEvent<
  "LiquidityBurnEvent",
  { sender: ContractAddress; recipient: ContractAddress },
  {
    amounts_redeemed: readonly [bigint, bigint];
    request_id: FixedBytes<32> | null;
  }
> {}

export interface LiquidityBurnEventFilter {
  sender?: ContractEventFilterValue<ContractAddress>;
  recipient?: ContractEventFilterValue<ContractAddress>;
}

export const LiquidityBurnEvent = defineContractEvent<
  "LiquidityBurnEvent",
  LiquidityBurnEvent["topics"],
  LiquidityBurnEvent["fields"],
  LiquidityBurnEventFilter
>({
  name: "LiquidityBurnEvent",
  signature: spec.events[0]!.signature,
  topics: [
    {
      name: "sender",
      type: spec.events[0]!.topics[0]!.ty,
      representation: "address",
    },
    {
      name: "recipient",
      type: spec.events[0]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [
    { name: "amounts_redeemed", type: spec.events[0]!.fields[0]!.ty },
    { name: "request_id", type: spec.events[0]!.fields[1]!.ty },
  ],
  codecs,
});

export interface LiquidityMintEvent extends DecodedContractEvent<
  "LiquidityMintEvent",
  { sender: ContractAddress; recipient: ContractAddress },
  { amount_minted: bigint; request_id: FixedBytes<32> | null }
> {}

export interface LiquidityMintEventFilter {
  sender?: ContractEventFilterValue<ContractAddress>;
  recipient?: ContractEventFilterValue<ContractAddress>;
}

export const LiquidityMintEvent = defineContractEvent<
  "LiquidityMintEvent",
  LiquidityMintEvent["topics"],
  LiquidityMintEvent["fields"],
  LiquidityMintEventFilter
>({
  name: "LiquidityMintEvent",
  signature: spec.events[1]!.signature,
  topics: [
    {
      name: "sender",
      type: spec.events[1]!.topics[0]!.ty,
      representation: "address",
    },
    {
      name: "recipient",
      type: spec.events[1]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [
    { name: "amount_minted", type: spec.events[1]!.fields[0]!.ty },
    { name: "request_id", type: spec.events[1]!.fields[1]!.ty },
  ],
  codecs,
});

export interface SwapEvent extends DecodedContractEvent<
  "SwapEvent",
  { sender: ContractAddress; recipient: ContractAddress },
  {
    amounts_in: readonly [bigint, bigint];
    amounts_out: readonly [bigint, bigint];
    request_id: FixedBytes<32> | null;
  }
> {}

export interface SwapEventFilter {
  sender?: ContractEventFilterValue<ContractAddress>;
  recipient?: ContractEventFilterValue<ContractAddress>;
}

export const SwapEvent = defineContractEvent<
  "SwapEvent",
  SwapEvent["topics"],
  SwapEvent["fields"],
  SwapEventFilter
>({
  name: "SwapEvent",
  signature: spec.events[2]!.signature,
  topics: [
    {
      name: "sender",
      type: spec.events[2]!.topics[0]!.ty,
      representation: "address",
    },
    {
      name: "recipient",
      type: spec.events[2]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [
    { name: "amounts_in", type: spec.events[2]!.fields[0]!.ty },
    { name: "amounts_out", type: spec.events[2]!.fields[1]!.ty },
    { name: "request_id", type: spec.events[2]!.fields[2]!.ty },
  ],
  codecs,
});

export interface SyncEvent extends DecodedContractEvent<
  "SyncEvent",
  {},
  { reserves: readonly [bigint, bigint] }
> {}

export type SyncEventFilter = Record<string, never>;

export const SyncEvent = defineContractEvent<
  "SyncEvent",
  SyncEvent["topics"],
  SyncEvent["fields"],
  SyncEventFilter
>({
  name: "SyncEvent",
  signature: spec.events[3]!.signature,
  topics: [],
  fields: [{ name: "reserves", type: spec.events[3]!.fields[0]!.ty }],
  codecs,
});

export type SwapHandlerEvent =
  LiquidityBurnEvent | LiquidityMintEvent | SwapEvent | SyncEvent;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapHandlerEvent | null {
  return (
    LiquidityBurnEvent.decode(event) ??
    LiquidityMintEvent.decode(event) ??
    SwapEvent.decode(event) ??
    SyncEvent.decode(event)
  );
}
