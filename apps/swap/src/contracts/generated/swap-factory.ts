// Generated from swap_factory.spec.xdr - SwapFactory interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  SwapFactory: {
    v0_1: {
      allPairsLength: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("c997d59c58cbd133"),
      ),
      createPair: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("789538868563a39b"),
      ),
      feeTo: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("77cbd350e6ae3409"),
      ),
      getPair: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d378a7e958fb08a6"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("572a56f10d32b386"),
      ),
      pairAt: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("9a0ddc11432790bc"),
      ),
      poolAddresses: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("31e651e7a88e0015"),
      ),
      poolFunding: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("2d0a74a4c0ac991b"),
      ),
    },
  },
} as const;

export namespace swap_if {
  export namespace v0_1 {
    export namespace events {
      export interface PoolCreated extends __gh_client_contract.DecodedContractEvent<
        "PoolCreated",
        {
          token0: __gh_protocol.ContractAddress;
          token1: __gh_protocol.ContractAddress;
        },
        {
          liquidity_token: __gh_protocol.ContractAddress;
          handler: __gh_protocol.ContractAddress;
          driver: __gh_protocol.ContractAddress;
          pair_count: bigint;
        }
      > {}

      export interface PoolCreatedFilter {
        token0?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        token1?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }

    export namespace factory {
      export interface Pool {
        liquidity_token: __gh_protocol.ContractAddress;
        handler: __gh_protocol.ContractAddress;
        driver: __gh_protocol.ContractAddress;
      }

      export interface PoolFunding {
        min: bigint;
        recommended: bigint;
      }

      export type SwapFactoryError = 1n | 2n | 3n | 4n | 5n;

      export interface SwapHashes {
        token: __gh_client_contract.FixedBytes<32>;
        handler: __gh_client_contract.FixedBytes<32>;
        driver: __gh_client_contract.FixedBytes<32>;
      }
    }

    export namespace handler {
      export type SwapLibraryError = 1n | 2n | 3n | 4n;

      export type SwapRequestError = 100n | 1n | 2n | 3n | 4n;
    }

    export namespace pair {
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
        | {
            case: "LPTokenFailure";
            value: readonly [
              __gh_codegen.thruput_erc20_if$v0_1$error$ERC20Error,
            ];
          };
    }
  }
}

export namespace thruput_erc20_if {
  export namespace v0_1 {
    export namespace error {
      export type ERC20Error = 1n | 2n | 3n | 4n | 5n | 100n;
    }
  }
}

export namespace SwapFactory {
  export namespace v0_1 {
    export type AllPairsLengthArgs = void;
    export type AllPairsLengthResult = bigint;

    export interface CreatePairArgs {
      tokenA: __gh_protocol.ContractAddress;
      tokenB: __gh_protocol.ContractAddress;
      funding: bigint;
    }
    export type CreatePairResult = __gh_codegen.swap_if$v0_1$factory$Pool;

    export type FeeToArgs = void;
    export type FeeToResult = __gh_protocol.ContractAddress | null;

    export interface GetPairArgs {
      tokenA: __gh_protocol.ContractAddress;
      tokenB: __gh_protocol.ContractAddress;
    }
    export type GetPairResult = __gh_protocol.ContractAddress | null;

    export interface InitializeArgs {
      hashes: __gh_codegen.swap_if$v0_1$factory$SwapHashes;
      feeTo: __gh_protocol.ContractAddress | null;
      router: __gh_protocol.ContractAddress;
    }
    export type InitializeResult = void;

    export interface PairAtArgs {
      index: bigint;
    }
    export type PairAtResult =
      | readonly [__gh_protocol.ContractAddress, __gh_protocol.ContractAddress]
      | null;

    export interface PoolAddressesArgs {
      tokenA: __gh_protocol.ContractAddress;
      tokenB: __gh_protocol.ContractAddress;
    }
    export type PoolAddressesResult = __gh_codegen.swap_if$v0_1$factory$Pool;

    export type PoolFundingArgs = void;
    export type PoolFundingResult =
      __gh_codegen.swap_if$v0_1$factory$PoolFunding;

    export type DeclaredException =
      | {
          kind: "declared";
          name: "SwapLibraryError";
          selector: 0x17e7e152700d9279n;
          value: __gh_codegen.swap_if$v0_1$handler$SwapLibraryError;
        }
      | {
          kind: "declared";
          name: "SwapPairError";
          selector: 0x25d002d47b07640dn;
          value: __gh_codegen.swap_if$v0_1$pair$SwapPairError;
        }
      | {
          kind: "declared";
          name: "SwapFactoryError";
          selector: 0x93e5de5a4268821fn;
          value: __gh_codegen.swap_if$v0_1$factory$SwapFactoryError;
        }
      | {
          kind: "declared";
          name: "SwapRequestError";
          selector: 0x947bdd51feea1ccen;
          value: __gh_codegen.swap_if$v0_1$handler$SwapRequestError;
        }
      | {
          kind: "declared";
          name: "ERC20Error";
          selector: 0xf63c8b1f5e7e2fe0n;
          value: __gh_codegen.thruput_erc20_if$v0_1$error$ERC20Error;
        };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("SwapFactory"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0x17e7e152700d9279n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::handler"),
              declared: __gh_s("SwapLibraryError"),
            },
          },
        },
        {
          selector: 0x25d002d47b07640dn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::pair"),
              declared: __gh_s("SwapPairError"),
            },
          },
        },
        {
          selector: 0x93e5de5a4268821fn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::factory"),
              declared: __gh_s("SwapFactoryError"),
            },
          },
        },
        {
          selector: 0x947bdd51feea1ccen,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::handler"),
              declared: __gh_s("SwapRequestError"),
            },
          },
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("thruput-erc20-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("thruput_erc20_if::error"),
              declared: __gh_s("ERC20Error"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("all_pairs_length"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U32 },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("create_pair"),
          args: [
            {
              name: __gh_s("token_a"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_b"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("funding"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::factory"),
              declared: __gh_s("Pool"),
            },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectStateChanging,
        },
        {
          name: __gh_s("fee_to"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("get_pair"),
          args: [
            {
              name: __gh_s("token_a"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_b"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("hashes"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("swap-if"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("swap_if::factory"),
                  declared: __gh_s("SwapHashes"),
                },
              },
            },
            {
              name: __gh_s("fee_to"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: {
                  v: __gh_contract_spec.ContractTypeKind.Address,
                },
              },
            },
            {
              name: __gh_s("router"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: __gh_client_contract.ContractMethodEffect.EffectStateChanging,
        },
        {
          name: __gh_s("pair_at"),
          args: [
            {
              name: __gh_s("index"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.Address },
                len: 2n,
              },
            },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("pool_addresses"),
          args: [
            {
              name: __gh_s("token_a"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_b"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::factory"),
              declared: __gh_s("Pool"),
            },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("pool_funding"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::factory"),
              declared: __gh_s("PoolFunding"),
            },
          },
          effect: __gh_client_contract.ContractMethodEffect.EffectPure,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::factory"),
          declared: __gh_s("Pool"),
        },
        fields: [
          {
            name: __gh_s("liquidity_token"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("handler"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("driver"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::factory"),
          declared: __gh_s("PoolFunding"),
        },
        fields: [
          {
            name: __gh_s("min"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("recommended"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::factory"),
          declared: __gh_s("SwapFactoryError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("IdenticalTokens"), value: 2n },
          { name: __gh_s("ZeroAddress"), value: 3n },
          { name: __gh_s("PairExists"), value: 4n },
          { name: __gh_s("InsufficientFunding"), value: 5n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::factory"),
          declared: __gh_s("SwapHashes"),
        },
        fields: [
          {
            name: __gh_s("token"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("handler"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("driver"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::handler"),
          declared: __gh_s("SwapLibraryError"),
        },
        variants: [
          { name: __gh_s("InsufficientAmount"), value: 1n },
          { name: __gh_s("InsufficientLiquidity"), value: 2n },
          { name: __gh_s("InsufficientInputAmount"), value: 3n },
          { name: __gh_s("InsufficientOutputAmount"), value: 4n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::handler"),
          declared: __gh_s("SwapRequestError"),
        },
        variants: [
          { name: __gh_s("Unauthorized"), value: 100n },
          { name: __gh_s("InsufficientAmountA"), value: 1n },
          { name: __gh_s("InsufficientAmountB"), value: 2n },
          { name: __gh_s("InsufficientOutputAmount"), value: 3n },
          { name: __gh_s("ExcessiveInputAmount"), value: 4n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefUnion,
      union_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::pair"),
          declared: __gh_s("SwapPairError"),
        },
        cases: [
          {
            name: __gh_s("InitializeFailed"),
            discriminant: 1n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("AlreadyInitialized"),
            discriminant: 2n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("NoLiquidityToBurn"),
            discriminant: 3n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InsufficientOutputAmount"),
            discriminant: 4n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InsufficientInputAmount"),
            discriminant: 5n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InsufficientLiquidity"),
            discriminant: 6n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InsufficientLiquidityMinted"),
            discriminant: 7n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InsufficientLiquidityBurned"),
            discriminant: 8n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InvalidDestination"),
            discriminant: 9n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("InvalidSwapProduct"),
            discriminant: 10n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("Overflow"),
            discriminant: 11n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("TransferFailed"),
            discriminant: 12n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseVoid,
            },
          },
          {
            name: __gh_s("LPTokenFailure"),
            discriminant: 13n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("thruput-erc20-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("thruput_erc20_if::error"),
                    declared: __gh_s("ERC20Error"),
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("thruput-erc20-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("thruput_erc20_if::error"),
          declared: __gh_s("ERC20Error"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("MustBeContractOwner"), value: 2n },
          { name: __gh_s("TooLarge"), value: 3n },
          { name: __gh_s("BalanceNotZero"), value: 4n },
          { name: __gh_s("NegativeAmount"), value: 5n },
          { name: __gh_s("Internal"), value: 100n },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("swap-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("swap_if::events"),
        declared: __gh_s("PoolCreated"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "84875c8465d82d67027d87293d17e751218930ae00dcdc00cee1a4bad46ad0f3",
        ),
      ),
      topics: [
        {
          name: __gh_s("token0"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("token1"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("liquidity_token"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("handler"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("driver"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("pair_count"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const SwapFactory = {
  v0_1: {
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    allPairsLength: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.AllPairsLengthArgs,
      SwapFactory.v0_1.AllPairsLengthResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "all_pairs_length",
      publicName: "allPairsLength",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.allPairsLength,
      effect: spec.interfaces[0]!.methods[0]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: stateChanging. Author declaration; not compiler/runtime enforced. */
    createPair: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.CreatePairArgs,
      SwapFactory.v0_1.CreatePairResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "create_pair",
      publicName: "createPair",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.createPair,
      effect: spec.interfaces[0]!.methods[1]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    feeTo: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.FeeToArgs,
      SwapFactory.v0_1.FeeToResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "fee_to",
      publicName: "feeTo",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.feeTo,
      effect: spec.interfaces[0]!.methods[2]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    getPair: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.GetPairArgs,
      SwapFactory.v0_1.GetPairResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "get_pair",
      publicName: "getPair",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.getPair,
      effect: spec.interfaces[0]!.methods[3]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: stateChanging. Author declaration; not compiler/runtime enforced. */
    initialize: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.InitializeArgs,
      SwapFactory.v0_1.InitializeResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[4]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    pairAt: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.PairAtArgs,
      SwapFactory.v0_1.PairAtResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "pair_at",
      publicName: "pairAt",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.pairAt,
      effect: spec.interfaces[0]!.methods[5]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    poolAddresses: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.PoolAddressesArgs,
      SwapFactory.v0_1.PoolAddressesResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "pool_addresses",
      publicName: "poolAddresses",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.poolAddresses,
      effect: spec.interfaces[0]!.methods[6]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: pure. Author declaration; not compiler/runtime enforced. */
    poolFunding: __gh_client_contract.defineContractMethod<
      SwapFactory.v0_1.PoolFundingArgs,
      SwapFactory.v0_1.PoolFundingResult,
      SwapFactory.v0_1.DeclaredException
    >({
      interfaceName: "SwapFactory",
      interfaceVersion: "0.1.0",
      abiName: "pool_funding",
      publicName: "poolFunding",
      entrypoint: __gh_entrypoints.SwapFactory.v0_1.poolFunding,
      effect: spec.interfaces[0]!.methods[7]!.effect,
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const swap_if = {
  v0_1: {
    events: {
      PoolCreated: __gh_client_contract.defineContractEvent<
        "PoolCreated",
        swap_if.v0_1.events.PoolCreated["topics"],
        swap_if.v0_1.events.PoolCreated["fields"],
        swap_if.v0_1.events.PoolCreatedFilter
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
        codecs: __gh_codecs,
      }),
    },
    factory: {
      SwapFactoryError: {
        AlreadyInitialized: 1n,
        IdenticalTokens: 2n,
        ZeroAddress: 3n,
        PairExists: 4n,
        InsufficientFunding: 5n,
      },
    },
    handler: {
      SwapLibraryError: {
        InsufficientAmount: 1n,
        InsufficientLiquidity: 2n,
        InsufficientInputAmount: 3n,
        InsufficientOutputAmount: 4n,
      },
      SwapRequestError: {
        Unauthorized: 100n,
        InsufficientAmountA: 1n,
        InsufficientAmountB: 2n,
        InsufficientOutputAmount: 3n,
        ExcessiveInputAmount: 4n,
      },
    },
  },
} as const;

export const thruput_erc20_if = {
  v0_1: {
    error: {
      ERC20Error: {
        AlreadyInitialized: 1n,
        MustBeContractOwner: 2n,
        TooLarge: 3n,
        BalanceNotZero: 4n,
        NegativeAmount: 5n,
        Internal: 100n,
      },
    },
  },
} as const;

export type SwapFactoryEvent = swap_if.v0_1.events.PoolCreated;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): SwapFactoryEvent | null {
  return swap_if.v0_1.events.PoolCreated.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type swap_if$v0_1$factory$Pool = swap_if.v0_1.factory.Pool;
  export type swap_if$v0_1$factory$PoolFunding =
    swap_if.v0_1.factory.PoolFunding;
  export type swap_if$v0_1$factory$SwapFactoryError =
    swap_if.v0_1.factory.SwapFactoryError;
  export type swap_if$v0_1$factory$SwapHashes = swap_if.v0_1.factory.SwapHashes;
  export type swap_if$v0_1$handler$SwapLibraryError =
    swap_if.v0_1.handler.SwapLibraryError;
  export type swap_if$v0_1$handler$SwapRequestError =
    swap_if.v0_1.handler.SwapRequestError;
  export type swap_if$v0_1$pair$SwapPairError = swap_if.v0_1.pair.SwapPairError;
  export type thruput_erc20_if$v0_1$error$ERC20Error =
    thruput_erc20_if.v0_1.error.ERC20Error;
}
