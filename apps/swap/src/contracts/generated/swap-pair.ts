// Generated from swap_pair.spec.xdr - SwapPair interface v0.1.0
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
  type FixedArray,
  type FixedBytes,
  defineContractEvent,
  type DecodedContractEvent,
  type ContractEventFilterValue,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  SwapPair: {
    burnLp: contractEntrypointID(fromHex("705c22a562ff032c")),
    getCumulativePrices: contractEntrypointID(fromHex("2c8a7c80e2383041")),
    getLiquidity: contractEntrypointID(fromHex("bb145b14cf47ac9e")),
    getReserves: contractEntrypointID(fromHex("2e3ade09b6853122")),
    initialize: contractEntrypointID(fromHex("63bc46a73c628899")),
    liquidityToken: contractEntrypointID(fromHex("08db7a0d5d6208d6")),
    mintLp: contractEntrypointID(fromHex("a1c5ce0f66270e4a")),
    skim: contractEntrypointID(fromHex("2e5c5baceed89524")),
    swap: contractEntrypointID(fromHex("24b9993b2cc41cbb")),
    sync: contractEntrypointID(fromHex("75928f04a99454a2")),
  },
} as const;

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

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

export interface U256 {
  limbs: FixedArray<bigint, 8>;
}

export interface SwapPairBurnLpArgs {
  to: ContractAddress;
  requestId: FixedBytes<32> | null;
}
export type SwapPairBurnLpResult = readonly [bigint, bigint];

export type SwapPairGetCumulativePricesArgs = void;
export type SwapPairGetCumulativePricesResult = readonly [U256, U256];

export type SwapPairGetLiquidityArgs = void;
export type SwapPairGetLiquidityResult = bigint;

export type SwapPairGetReservesArgs = void;
export type SwapPairGetReservesResult = readonly [bigint, bigint, bigint];

export interface SwapPairInitializeArgs {
  factory: ContractAddress;
  token0: ContractAddress;
  token1: ContractAddress;
  lpToken: ContractAddress;
}
export type SwapPairInitializeResult = void;

export type SwapPairLiquidityTokenArgs = void;
export type SwapPairLiquidityTokenResult = ContractAddress;

export interface SwapPairMintLpArgs {
  to: ContractAddress;
  requestId: FixedBytes<32> | null;
}
export type SwapPairMintLpResult = bigint;

export interface SwapPairSkimArgs {
  to: ContractAddress;
}
export type SwapPairSkimResult = void;

export interface SwapPairSwapArgs {
  amount0Out: bigint;
  amount1Out: bigint;
  to: ContractAddress;
  requestId: FixedBytes<32> | null;
}
export type SwapPairSwapResult = void;

export type SwapPairSyncArgs = void;
export type SwapPairSyncResult = void;

export type SwapPairDeclaredAbort =
  | {
      kind: "declared";
      exception: "SwapPairError";
      selector: 0x25d002d47b07640dn;
      value: SwapPairError;
    }
  | {
      kind: "declared";
      exception: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: ERC20Error;
    };
export type SwapPairAbort = ContractAbort<SwapPairDeclaredAbort>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapPair"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0x25d002d47b07640dn,
          ty: { v: ContractTypeKind.Named, named: s("SwapPairError") },
        },
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
      ],
      methods: [
        {
          name: s("burn_lp"),
          args: [
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U128 }, len: 2n },
          },
        },
        {
          name: s("get_cumulative_prices"),
          args: [],
          return_type: {
            v: ContractTypeKind.Array,
            array: {
              element: { v: ContractTypeKind.Named, named: s("U256") },
              len: 2n,
            },
          },
        },
        {
          name: s("get_liquidity"),
          args: [],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("get_reserves"),
          args: [],
          return_type: {
            v: ContractTypeKind.Tuple,
            tuple: [
              { v: ContractTypeKind.U128 },
              { v: ContractTypeKind.U128 },
              { v: ContractTypeKind.U32 },
            ],
          },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("factory"), ty: { v: ContractTypeKind.Address } },
            { name: s("token0"), ty: { v: ContractTypeKind.Address } },
            { name: s("token1"), ty: { v: ContractTypeKind.Address } },
            { name: s("lp_token"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("liquidity_token"),
          args: [],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("mint_lp"),
          args: [
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("skim"),
          args: [{ name: s("to"), ty: { v: ContractTypeKind.Address } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("swap"),
          args: [
            { name: s("amount0_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount1_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
        name: s("U256"),
        fields: [
          {
            name: s("limbs"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U32 }, len: 8n },
            },
          },
        ],
      },
    },
  ],
  events: [
    {
      name: s("BurnEvent"),
      signature: topic(
        fromHex(
          "44934a1f6a6a0d7c09f5464a14adefd9da1e9cde4d9420b333fecb917c47f52c",
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
      name: s("MintEvent"),
      signature: topic(
        fromHex(
          "48e990a9515a2084882012e9e7c7cf93100fd7f03be5f1665969aefe519444be",
        ),
      ),
      topics: [{ name: s("sender"), ty: { v: ContractTypeKind.Address } }],
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

export const SwapPair = {
  burnLp: defineContractMethod<
    SwapPairBurnLpArgs,
    SwapPairBurnLpResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.burnLp,
    args: [
      {
        abiName: "to",
        publicName: "to",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
      {
        abiName: "request_id",
        publicName: "requestId",
        type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  getCumulativePrices: defineContractMethod<
    SwapPairGetCumulativePricesArgs,
    SwapPairGetCumulativePricesResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.getCumulativePrices,
    args: [],
    returnType: spec.interfaces[0]!.methods[1]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  getLiquidity: defineContractMethod<
    SwapPairGetLiquidityArgs,
    SwapPairGetLiquidityResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.getLiquidity,
    args: [],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  getReserves: defineContractMethod<
    SwapPairGetReservesArgs,
    SwapPairGetReservesResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.getReserves,
    args: [],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    SwapPairInitializeArgs,
    SwapPairInitializeResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.initialize,
    args: [
      {
        abiName: "factory",
        publicName: "factory",
        type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
      },
      {
        abiName: "token0",
        publicName: "token0",
        type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
      },
      {
        abiName: "token1",
        publicName: "token1",
        type: spec.interfaces[0]!.methods[4]!.args[2]!.ty,
      },
      {
        abiName: "lp_token",
        publicName: "lpToken",
        type: spec.interfaces[0]!.methods[4]!.args[3]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[4]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  liquidityToken: defineContractMethod<
    SwapPairLiquidityTokenArgs,
    SwapPairLiquidityTokenResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.liquidityToken,
    args: [],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  mintLp: defineContractMethod<
    SwapPairMintLpArgs,
    SwapPairMintLpResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.mintLp,
    args: [
      {
        abiName: "to",
        publicName: "to",
        type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
      },
      {
        abiName: "request_id",
        publicName: "requestId",
        type: spec.interfaces[0]!.methods[6]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[6]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  skim: defineContractMethod<
    SwapPairSkimArgs,
    SwapPairSkimResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.skim,
    args: [
      {
        abiName: "to",
        publicName: "to",
        type: spec.interfaces[0]!.methods[7]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[7]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  swap: defineContractMethod<
    SwapPairSwapArgs,
    SwapPairSwapResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.swap,
    args: [
      {
        abiName: "amount0_out",
        publicName: "amount0Out",
        type: spec.interfaces[0]!.methods[8]!.args[0]!.ty,
      },
      {
        abiName: "amount1_out",
        publicName: "amount1Out",
        type: spec.interfaces[0]!.methods[8]!.args[1]!.ty,
      },
      {
        abiName: "to",
        publicName: "to",
        type: spec.interfaces[0]!.methods[8]!.args[2]!.ty,
      },
      {
        abiName: "request_id",
        publicName: "requestId",
        type: spec.interfaces[0]!.methods[8]!.args[3]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[8]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  sync: defineContractMethod<
    SwapPairSyncArgs,
    SwapPairSyncResult,
    SwapPairDeclaredAbort
  >({
    entrypoint: entrypoints.SwapPair.sync,
    args: [],
    returnType: spec.interfaces[0]!.methods[9]!.return_type,
    throws: [
      {
        selector: 0x25d002d47b07640dn,
        exception: "SwapPairError",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        exception: "ERC20Error",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export interface BurnEvent extends DecodedContractEvent<
  "BurnEvent",
  { sender: ContractAddress; recipient: ContractAddress },
  {
    amounts_redeemed: readonly [bigint, bigint];
    request_id: FixedBytes<32> | null;
  }
> {}

export interface BurnEventFilter {
  sender?: ContractEventFilterValue<ContractAddress>;
  recipient?: ContractEventFilterValue<ContractAddress>;
}

export const BurnEvent = defineContractEvent<
  "BurnEvent",
  BurnEvent["topics"],
  BurnEvent["fields"],
  BurnEventFilter
>({
  name: "BurnEvent",
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

export interface MintEvent extends DecodedContractEvent<
  "MintEvent",
  { sender: ContractAddress },
  { amount_minted: bigint; request_id: FixedBytes<32> | null }
> {}

export interface MintEventFilter {
  sender?: ContractEventFilterValue<ContractAddress>;
}

export const MintEvent = defineContractEvent<
  "MintEvent",
  MintEvent["topics"],
  MintEvent["fields"],
  MintEventFilter
>({
  name: "MintEvent",
  signature: spec.events[1]!.signature,
  topics: [
    {
      name: "sender",
      type: spec.events[1]!.topics[0]!.ty,
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

export type SwapPairEvent = BurnEvent | MintEvent | SwapEvent | SyncEvent;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapPairEvent | null {
  return (
    BurnEvent.decode(event) ??
    MintEvent.decode(event) ??
    SwapEvent.decode(event) ??
    SyncEvent.decode(event)
  );
}
