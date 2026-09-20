// Generated from swap_router.spec.xdr - SwapRouter interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress } from "@groundhogchain/protocol";
import { contractEntrypointID } from "@groundhogchain/protocol";
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
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  SwapRouter: {
    addLiquidity: contractEntrypointID(fromHex("22f5cdbafa511c21")),
    initialize: contractEntrypointID(fromHex("ea244f21cfff2c93")),
    removeLiquidity: contractEntrypointID(fromHex("03d0c974a5d1ffd3")),
    swapExactTokensForTokens: contractEntrypointID(fromHex("f2cb644718a29783")),
    swapTokensForExactTokens: contractEntrypointID(fromHex("48cafe69d7df5886")),
  },
} as const;

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

export const SwapDriverError = {
  BatchTooSmall: 1n,
  AlreadyInitialized: 2n,
  InvalidConfiguration: 3n,
  Unauthorized: 4n,
} as const;

export type SwapDriverError =
  (typeof SwapDriverError)[keyof typeof SwapDriverError];

export const SwapFactoryError = {
  AlreadyInitialized: 1n,
  IdenticalTokens: 2n,
  ZeroAddress: 3n,
  PairExists: 4n,
  InsufficientFunding: 5n,
} as const;

export type SwapFactoryError =
  (typeof SwapFactoryError)[keyof typeof SwapFactoryError];

export const SwapLibraryError = {
  InsufficientAmount: 1n,
  InsufficientLiquidity: 2n,
  InsufficientInputAmount: 3n,
  InsufficientOutputAmount: 4n,
} as const;

export type SwapLibraryError =
  (typeof SwapLibraryError)[keyof typeof SwapLibraryError];

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

export const SwapRequestError = {
  Unauthorized: 100n,
  InsufficientAmountA: 1n,
  InsufficientAmountB: 2n,
  InsufficientOutputAmount: 3n,
  ExcessiveInputAmount: 4n,
} as const;

export type SwapRequestError =
  (typeof SwapRequestError)[keyof typeof SwapRequestError];

export const SwapRouterError = {
  AlreadyInitialized: 1n,
  NoSuchPair: 2n,
} as const;

export type SwapRouterError =
  (typeof SwapRouterError)[keyof typeof SwapRouterError];

export interface SwapRouterAddLiquidityArgs {
  tokenA: ContractAddress;
  tokenB: ContractAddress;
  amountsDesired: readonly [bigint, bigint];
  amountsMin: readonly [bigint, bigint];
  recipient: ContractAddress;
}
export type SwapRouterAddLiquidityResult = FixedBytes<32>;

export interface SwapRouterInitializeArgs {
  factory: ContractAddress;
}
export type SwapRouterInitializeResult = void;

export interface SwapRouterRemoveLiquidityArgs {
  tokenA: ContractAddress;
  tokenB: ContractAddress;
  liquidity: bigint;
  amountsMin: readonly [bigint, bigint];
  recipient: ContractAddress;
}
export type SwapRouterRemoveLiquidityResult = FixedBytes<32>;

export interface SwapRouterSwapExactTokensForTokensArgs {
  amountIn: bigint;
  amountOutMin: bigint;
  tokenIn: ContractAddress;
  tokenOut: ContractAddress;
  recipient: ContractAddress;
}
export type SwapRouterSwapExactTokensForTokensResult = FixedBytes<32>;

export interface SwapRouterSwapTokensForExactTokensArgs {
  amountOut: bigint;
  amountInMax: bigint;
  tokenIn: ContractAddress;
  tokenOut: ContractAddress;
  recipient: ContractAddress;
}
export type SwapRouterSwapTokensForExactTokensResult = FixedBytes<32>;

export type SwapRouterDeclaredException =
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
      name: "SwapFactoryError";
      selector: 0x93e5de5a4268821fn;
      value: SwapFactoryError;
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
    }
  | {
      kind: "declared";
      name: "SwapDriverError";
      selector: 0xb7f3f28894243a52n;
      value: SwapDriverError;
    }
  | {
      kind: "declared";
      name: "SwapRouterError";
      selector: 0xb9654b95411d2dban;
      value: SwapRouterError;
    };
export type SwapRouterException =
  ContractException<SwapRouterDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapRouter"),
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
          selector: 0x93e5de5a4268821fn,
          ty: { v: ContractTypeKind.Named, named: s("SwapFactoryError") },
        },
        {
          selector: 0x947bdd51feea1ccen,
          ty: { v: ContractTypeKind.Named, named: s("SwapRequestError") },
        },
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
        {
          selector: 0xb7f3f28894243a52n,
          ty: { v: ContractTypeKind.Named, named: s("SwapDriverError") },
        },
        {
          selector: 0xb9654b95411d2dban,
          ty: { v: ContractTypeKind.Named, named: s("SwapRouterError") },
        },
      ],
      methods: [
        {
          name: s("add_liquidity"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
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
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
        {
          name: s("initialize"),
          args: [{ name: s("factory"), ty: { v: ContractTypeKind.Address } }],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("remove_liquidity"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
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
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
        {
          name: s("swap_exact_tokens_for_tokens"),
          args: [
            { name: s("amount_in"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount_out_min"), ty: { v: ContractTypeKind.U128 } },
            { name: s("token_in"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_out"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
        {
          name: s("swap_tokens_for_exact_tokens"),
          args: [
            { name: s("amount_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount_in_max"), ty: { v: ContractTypeKind.U128 } },
            { name: s("token_in"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_out"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
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
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapDriverError"),
        variants: [
          { name: s("BatchTooSmall"), value: 1n },
          { name: s("AlreadyInitialized"), value: 2n },
          { name: s("InvalidConfiguration"), value: 3n },
          { name: s("Unauthorized"), value: 4n },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapFactoryError"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("IdenticalTokens"), value: 2n },
          { name: s("ZeroAddress"), value: 3n },
          { name: s("PairExists"), value: 4n },
          { name: s("InsufficientFunding"), value: 5n },
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
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapRouterError"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("NoSuchPair"), value: 2n },
        ],
      },
    },
  ],
  events: [],
};

const codecs = createContractCodecContext(spec.type_defs);

export const SwapRouter = {
  addLiquidity: defineContractMethod<
    SwapRouterAddLiquidityArgs,
    SwapRouterAddLiquidityResult,
    SwapRouterDeclaredException
  >({
    interfaceName: "SwapRouter",
    interfaceVersion: "0.1.0",
    abiName: "add_liquidity",
    publicName: "addLiquidity",
    entrypoint: entrypoints.SwapRouter.addLiquidity,
    args: [
      {
        abiName: "token_a",
        publicName: "tokenA",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
      {
        abiName: "token_b",
        publicName: "tokenB",
        type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
      },
      {
        abiName: "amounts_desired",
        publicName: "amountsDesired",
        type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
      },
      {
        abiName: "amounts_min",
        publicName: "amountsMin",
        type: spec.interfaces[0]!.methods[0]!.args[3]!.ty,
      },
      {
        abiName: "recipient",
        publicName: "recipient",
        type: spec.interfaces[0]!.methods[0]!.args[4]!.ty,
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
        selector: 0x93e5de5a4268821fn,
        name: "SwapFactoryError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[4]!.ty,
      },
      {
        selector: 0xb7f3f28894243a52n,
        name: "SwapDriverError",
        type: spec.interfaces[0]!.throws[5]!.ty,
      },
      {
        selector: 0xb9654b95411d2dban,
        name: "SwapRouterError",
        type: spec.interfaces[0]!.throws[6]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    SwapRouterInitializeArgs,
    SwapRouterInitializeResult,
    SwapRouterDeclaredException
  >({
    interfaceName: "SwapRouter",
    interfaceVersion: "0.1.0",
    abiName: "initialize",
    publicName: "initialize",
    entrypoint: entrypoints.SwapRouter.initialize,
    args: [
      {
        abiName: "factory",
        publicName: "factory",
        type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
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
        selector: 0x93e5de5a4268821fn,
        name: "SwapFactoryError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[4]!.ty,
      },
      {
        selector: 0xb7f3f28894243a52n,
        name: "SwapDriverError",
        type: spec.interfaces[0]!.throws[5]!.ty,
      },
      {
        selector: 0xb9654b95411d2dban,
        name: "SwapRouterError",
        type: spec.interfaces[0]!.throws[6]!.ty,
      },
    ],
    codecs,
  }),
  removeLiquidity: defineContractMethod<
    SwapRouterRemoveLiquidityArgs,
    SwapRouterRemoveLiquidityResult,
    SwapRouterDeclaredException
  >({
    interfaceName: "SwapRouter",
    interfaceVersion: "0.1.0",
    abiName: "remove_liquidity",
    publicName: "removeLiquidity",
    entrypoint: entrypoints.SwapRouter.removeLiquidity,
    args: [
      {
        abiName: "token_a",
        publicName: "tokenA",
        type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
      },
      {
        abiName: "token_b",
        publicName: "tokenB",
        type: spec.interfaces[0]!.methods[2]!.args[1]!.ty,
      },
      {
        abiName: "liquidity",
        publicName: "liquidity",
        type: spec.interfaces[0]!.methods[2]!.args[2]!.ty,
      },
      {
        abiName: "amounts_min",
        publicName: "amountsMin",
        type: spec.interfaces[0]!.methods[2]!.args[3]!.ty,
      },
      {
        abiName: "recipient",
        publicName: "recipient",
        type: spec.interfaces[0]!.methods[2]!.args[4]!.ty,
      },
    ],
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
        selector: 0x93e5de5a4268821fn,
        name: "SwapFactoryError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[4]!.ty,
      },
      {
        selector: 0xb7f3f28894243a52n,
        name: "SwapDriverError",
        type: spec.interfaces[0]!.throws[5]!.ty,
      },
      {
        selector: 0xb9654b95411d2dban,
        name: "SwapRouterError",
        type: spec.interfaces[0]!.throws[6]!.ty,
      },
    ],
    codecs,
  }),
  swapExactTokensForTokens: defineContractMethod<
    SwapRouterSwapExactTokensForTokensArgs,
    SwapRouterSwapExactTokensForTokensResult,
    SwapRouterDeclaredException
  >({
    interfaceName: "SwapRouter",
    interfaceVersion: "0.1.0",
    abiName: "swap_exact_tokens_for_tokens",
    publicName: "swapExactTokensForTokens",
    entrypoint: entrypoints.SwapRouter.swapExactTokensForTokens,
    args: [
      {
        abiName: "amount_in",
        publicName: "amountIn",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
      {
        abiName: "amount_out_min",
        publicName: "amountOutMin",
        type: spec.interfaces[0]!.methods[3]!.args[1]!.ty,
      },
      {
        abiName: "token_in",
        publicName: "tokenIn",
        type: spec.interfaces[0]!.methods[3]!.args[2]!.ty,
      },
      {
        abiName: "token_out",
        publicName: "tokenOut",
        type: spec.interfaces[0]!.methods[3]!.args[3]!.ty,
      },
      {
        abiName: "recipient",
        publicName: "recipient",
        type: spec.interfaces[0]!.methods[3]!.args[4]!.ty,
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
        selector: 0x93e5de5a4268821fn,
        name: "SwapFactoryError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[4]!.ty,
      },
      {
        selector: 0xb7f3f28894243a52n,
        name: "SwapDriverError",
        type: spec.interfaces[0]!.throws[5]!.ty,
      },
      {
        selector: 0xb9654b95411d2dban,
        name: "SwapRouterError",
        type: spec.interfaces[0]!.throws[6]!.ty,
      },
    ],
    codecs,
  }),
  swapTokensForExactTokens: defineContractMethod<
    SwapRouterSwapTokensForExactTokensArgs,
    SwapRouterSwapTokensForExactTokensResult,
    SwapRouterDeclaredException
  >({
    interfaceName: "SwapRouter",
    interfaceVersion: "0.1.0",
    abiName: "swap_tokens_for_exact_tokens",
    publicName: "swapTokensForExactTokens",
    entrypoint: entrypoints.SwapRouter.swapTokensForExactTokens,
    args: [
      {
        abiName: "amount_out",
        publicName: "amountOut",
        type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
      },
      {
        abiName: "amount_in_max",
        publicName: "amountInMax",
        type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
      },
      {
        abiName: "token_in",
        publicName: "tokenIn",
        type: spec.interfaces[0]!.methods[4]!.args[2]!.ty,
      },
      {
        abiName: "token_out",
        publicName: "tokenOut",
        type: spec.interfaces[0]!.methods[4]!.args[3]!.ty,
      },
      {
        abiName: "recipient",
        publicName: "recipient",
        type: spec.interfaces[0]!.methods[4]!.args[4]!.ty,
      },
    ],
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
        selector: 0x93e5de5a4268821fn,
        name: "SwapFactoryError",
        type: spec.interfaces[0]!.throws[2]!.ty,
      },
      {
        selector: 0x947bdd51feea1ccen,
        name: "SwapRequestError",
        type: spec.interfaces[0]!.throws[3]!.ty,
      },
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[4]!.ty,
      },
      {
        selector: 0xb7f3f28894243a52n,
        name: "SwapDriverError",
        type: spec.interfaces[0]!.throws[5]!.ty,
      },
      {
        selector: 0xb9654b95411d2dban,
        name: "SwapRouterError",
        type: spec.interfaces[0]!.throws[6]!.ty,
      },
    ],
    codecs,
  }),
} as const;
