// Generated from swap_factory.spec.xdr - SwapFactory interface v0.1.0
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
  SwapFactory: {
    allPairsLength: contractEntrypointID(fromHex("c997d59c58cbd133")),
    createPair: contractEntrypointID(fromHex("789538868563a39b")),
    feeTo: contractEntrypointID(fromHex("77cbd350e6ae3409")),
    getPair: contractEntrypointID(fromHex("d378a7e958fb08a6")),
    initialize: contractEntrypointID(fromHex("572a56f10d32b386")),
    pairAt: contractEntrypointID(fromHex("9a0ddc11432790bc")),
    poolAddresses: contractEntrypointID(fromHex("31e651e7a88e0015")),
    poolFunding: contractEntrypointID(fromHex("2d0a74a4c0ac991b")),
  },
} as const;

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

export interface Pool {
  liquidity_token: ContractAddress;
  handler: ContractAddress;
  driver: ContractAddress;
}

export interface PoolFunding {
  min: bigint;
  recommended: bigint;
}

export const SwapFactoryError = {
  AlreadyInitialized: 1n,
  IdenticalTokens: 2n,
  ZeroAddress: 3n,
  PairExists: 4n,
  InsufficientFunding: 5n,
} as const;

export type SwapFactoryError =
  (typeof SwapFactoryError)[keyof typeof SwapFactoryError];

export interface SwapHashes {
  token: FixedBytes<32>;
  handler: FixedBytes<32>;
  driver: FixedBytes<32>;
}

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

export type SwapFactoryAllPairsLengthArgs = void;
export type SwapFactoryAllPairsLengthResult = bigint;

export interface SwapFactoryCreatePairArgs {
  tokenA: ContractAddress;
  tokenB: ContractAddress;
  funding: bigint;
}
export type SwapFactoryCreatePairResult = Pool;

export type SwapFactoryFeeToArgs = void;
export type SwapFactoryFeeToResult = ContractAddress | null;

export interface SwapFactoryGetPairArgs {
  tokenA: ContractAddress;
  tokenB: ContractAddress;
}
export type SwapFactoryGetPairResult = ContractAddress | null;

export interface SwapFactoryInitializeArgs {
  hashes: SwapHashes;
  feeTo: ContractAddress | null;
  router: ContractAddress;
}
export type SwapFactoryInitializeResult = void;

export interface SwapFactoryPairAtArgs {
  index: bigint;
}
export type SwapFactoryPairAtResult =
  readonly [ContractAddress, ContractAddress] | null;

export interface SwapFactoryPoolAddressesArgs {
  tokenA: ContractAddress;
  tokenB: ContractAddress;
}
export type SwapFactoryPoolAddressesResult = Pool;

export type SwapFactoryPoolFundingArgs = void;
export type SwapFactoryPoolFundingResult = PoolFunding;

export type SwapFactoryDeclaredException =
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
    };
export type SwapFactoryException =
  ContractException<SwapFactoryDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapFactory"),
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
      ],
      methods: [
        {
          name: s("all_pairs_length"),
          args: [],
          return_type: { v: ContractTypeKind.U32 },
        },
        {
          name: s("create_pair"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
            { name: s("funding"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Named, named: s("Pool") },
        },
        {
          name: s("fee_to"),
          args: [],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.Address },
          },
        },
        {
          name: s("get_pair"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.Address },
          },
        },
        {
          name: s("initialize"),
          args: [
            {
              name: s("hashes"),
              ty: { v: ContractTypeKind.Named, named: s("SwapHashes") },
            },
            {
              name: s("fee_to"),
              ty: {
                v: ContractTypeKind.Option,
                option_inner: { v: ContractTypeKind.Address },
              },
            },
            { name: s("router"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("pair_at"),
          args: [{ name: s("index"), ty: { v: ContractTypeKind.U32 } }],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.Address }, len: 2n },
            },
          },
        },
        {
          name: s("pool_addresses"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Named, named: s("Pool") },
        },
        {
          name: s("pool_funding"),
          args: [],
          return_type: { v: ContractTypeKind.Named, named: s("PoolFunding") },
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
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("Pool"),
        fields: [
          { name: s("liquidity_token"), ty: { v: ContractTypeKind.Address } },
          { name: s("handler"), ty: { v: ContractTypeKind.Address } },
          { name: s("driver"), ty: { v: ContractTypeKind.Address } },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("PoolFunding"),
        fields: [
          { name: s("min"), ty: { v: ContractTypeKind.U128 } },
          { name: s("recommended"), ty: { v: ContractTypeKind.U128 } },
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
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("SwapHashes"),
        fields: [
          {
            name: s("token"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          {
            name: s("handler"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          {
            name: s("driver"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
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
  ],
  events: [
    {
      name: s("PoolCreated"),
      signature: topic(
        fromHex(
          "84875c8465d82d67027d87293d17e751218930ae00dcdc00cee1a4bad46ad0f3",
        ),
      ),
      topics: [
        { name: s("token0"), ty: { v: ContractTypeKind.Address } },
        { name: s("token1"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("liquidity_token"), ty: { v: ContractTypeKind.Address } },
        { name: s("handler"), ty: { v: ContractTypeKind.Address } },
        { name: s("driver"), ty: { v: ContractTypeKind.Address } },
        { name: s("pair_count"), ty: { v: ContractTypeKind.U32 } },
      ],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const SwapFactory = {
  allPairsLength: defineContractMethod<
    SwapFactoryAllPairsLengthArgs,
    SwapFactoryAllPairsLengthResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.allPairsLength,
    args: [],
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
    ],
    codecs,
  }),
  createPair: defineContractMethod<
    SwapFactoryCreatePairArgs,
    SwapFactoryCreatePairResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.createPair,
    args: [
      {
        abiName: "token_a",
        publicName: "tokenA",
        type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
      },
      {
        abiName: "token_b",
        publicName: "tokenB",
        type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
      },
      {
        abiName: "funding",
        publicName: "funding",
        type: spec.interfaces[0]!.methods[1]!.args[2]!.ty,
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
    ],
    codecs,
  }),
  feeTo: defineContractMethod<
    SwapFactoryFeeToArgs,
    SwapFactoryFeeToResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.feeTo,
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
    ],
    codecs,
  }),
  getPair: defineContractMethod<
    SwapFactoryGetPairArgs,
    SwapFactoryGetPairResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.getPair,
    args: [
      {
        abiName: "token_a",
        publicName: "tokenA",
        type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
      },
      {
        abiName: "token_b",
        publicName: "tokenB",
        type: spec.interfaces[0]!.methods[3]!.args[1]!.ty,
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
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    SwapFactoryInitializeArgs,
    SwapFactoryInitializeResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.initialize,
    args: [
      {
        abiName: "hashes",
        publicName: "hashes",
        type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
      },
      {
        abiName: "fee_to",
        publicName: "feeTo",
        type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
      },
      {
        abiName: "router",
        publicName: "router",
        type: spec.interfaces[0]!.methods[4]!.args[2]!.ty,
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
    ],
    codecs,
  }),
  pairAt: defineContractMethod<
    SwapFactoryPairAtArgs,
    SwapFactoryPairAtResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.pairAt,
    args: [
      {
        abiName: "index",
        publicName: "index",
        type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
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
    ],
    codecs,
  }),
  poolAddresses: defineContractMethod<
    SwapFactoryPoolAddressesArgs,
    SwapFactoryPoolAddressesResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.poolAddresses,
    args: [
      {
        abiName: "token_a",
        publicName: "tokenA",
        type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
      },
      {
        abiName: "token_b",
        publicName: "tokenB",
        type: spec.interfaces[0]!.methods[6]!.args[1]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[6]!.return_type,
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
    ],
    codecs,
  }),
  poolFunding: defineContractMethod<
    SwapFactoryPoolFundingArgs,
    SwapFactoryPoolFundingResult,
    SwapFactoryDeclaredException
  >({
    entrypoint: entrypoints.SwapFactory.poolFunding,
    args: [],
    returnType: spec.interfaces[0]!.methods[7]!.return_type,
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
    ],
    codecs,
  }),
} as const;

export interface PoolCreated extends DecodedContractEvent<
  "PoolCreated",
  { token0: ContractAddress; token1: ContractAddress },
  {
    liquidity_token: ContractAddress;
    handler: ContractAddress;
    driver: ContractAddress;
    pair_count: bigint;
  }
> {}

export interface PoolCreatedFilter {
  token0?: ContractEventFilterValue<ContractAddress>;
  token1?: ContractEventFilterValue<ContractAddress>;
}

export const PoolCreated = defineContractEvent<
  "PoolCreated",
  PoolCreated["topics"],
  PoolCreated["fields"],
  PoolCreatedFilter
>({
  name: "PoolCreated",
  signature: spec.events[0]!.signature,
  topics: [
    {
      name: "token0",
      type: spec.events[0]!.topics[0]!.ty,
      representation: "address",
    },
    {
      name: "token1",
      type: spec.events[0]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [
    { name: "liquidity_token", type: spec.events[0]!.fields[0]!.ty },
    { name: "handler", type: spec.events[0]!.fields[1]!.ty },
    { name: "driver", type: spec.events[0]!.fields[2]!.ty },
    { name: "pair_count", type: spec.events[0]!.fields[3]!.ty },
  ],
  codecs,
});

export type SwapFactoryEvent = PoolCreated;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): SwapFactoryEvent | null {
  return PoolCreated.decode(event);
}
