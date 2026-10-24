// Generated from swap_handler.spec.xdr - SwapHandler interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  SwapHandler: {
    v0_1: {
      claimCrank: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("82c09b7ba7bc0fad"),
      ),
      handleRequest: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("45c30c0e5c3ad2b1"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("666b73d370c19654"),
      ),
      poolState: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("99df53a24d53d371"),
      ),
      skim: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("96e630c21054936f"),
      ),
      sync: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("03338c16cd55a918"),
      ),
    },
  },
} as const;

export namespace swap_if {
  export namespace v0_1 {
    export namespace events {
      export interface LiquidityBurnEvent extends __gh_client_contract.DecodedContractEvent<
        "LiquidityBurnEvent",
        {
          sender: __gh_protocol.ContractAddress;
          recipient: __gh_protocol.ContractAddress;
        },
        {
          amounts_redeemed: readonly [bigint, bigint];
          request_id: __gh_client_contract.FixedBytes<32> | null;
        }
      > {}

      export interface LiquidityBurnEventFilter {
        sender?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        recipient?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface LiquidityMintEvent extends __gh_client_contract.DecodedContractEvent<
        "LiquidityMintEvent",
        {
          sender: __gh_protocol.ContractAddress;
          recipient: __gh_protocol.ContractAddress;
        },
        {
          amount_minted: bigint;
          request_id: __gh_client_contract.FixedBytes<32> | null;
        }
      > {}

      export interface LiquidityMintEventFilter {
        sender?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        recipient?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface SwapEvent extends __gh_client_contract.DecodedContractEvent<
        "SwapEvent",
        {
          sender: __gh_protocol.ContractAddress;
          recipient: __gh_protocol.ContractAddress;
        },
        {
          amounts_in: readonly [bigint, bigint];
          amounts_out: readonly [bigint, bigint];
          request_id: __gh_client_contract.FixedBytes<32> | null;
        }
      > {}

      export interface SwapEventFilter {
        sender?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        recipient?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface SyncEvent extends __gh_client_contract.DecodedContractEvent<
        "SyncEvent",
        {},
        { reserves: readonly [bigint, bigint] }
      > {}

      export type SyncEventFilter = globalThis.Record<string, never>;
    }

    export namespace handler {
      export interface PoolState {
        reserves: readonly [bigint, bigint];
        block_timestamp: bigint;
        liquidity: bigint;
        liquidity_token: __gh_protocol.ContractAddress;
        cumulative_prices: readonly [bigint, bigint];
      }

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

    export namespace request {
      export interface AddLiquidityRequest {
        purchaser: __gh_protocol.ContractAddress;
        amounts_desired: readonly [bigint, bigint];
        amounts_min: readonly [bigint, bigint];
        recipient: __gh_protocol.ContractAddress;
      }

      export interface RemoveLiquidityRequest {
        redeemer: __gh_protocol.ContractAddress;
        liquidity: bigint;
        amounts_min: readonly [bigint, bigint];
        recipient: __gh_protocol.ContractAddress;
      }

      export interface SwapExactInRequest {
        trader: __gh_protocol.ContractAddress;
        amount_in: bigint;
        amount_out_min: bigint;
        in_index: bigint;
        recipient: __gh_protocol.ContractAddress;
      }

      export interface SwapExactOutRequest {
        trader: __gh_protocol.ContractAddress;
        amount_out: bigint;
        amount_in_max: bigint;
        in_index: bigint;
        recipient: __gh_protocol.ContractAddress;
      }

      export type SwapOp =
        | {
            case: "AddLiquidity";
            value: readonly [
              __gh_codegen.swap_if$v0_1$request$AddLiquidityRequest,
            ];
          }
        | {
            case: "RemoveLiquidity";
            value: readonly [
              __gh_codegen.swap_if$v0_1$request$RemoveLiquidityRequest,
            ];
          }
        | {
            case: "SwapExactIn";
            value: readonly [
              __gh_codegen.swap_if$v0_1$request$SwapExactInRequest,
            ];
          }
        | {
            case: "SwapExactOut";
            value: readonly [
              __gh_codegen.swap_if$v0_1$request$SwapExactOutRequest,
            ];
          };

      export interface SwapRequest {
        request_id: __gh_client_contract.FixedBytes<32>;
        op: __gh_codegen.swap_if$v0_1$request$SwapOp;
      }
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

export namespace SwapHandler {
  export namespace v0_1 {
    export type ClaimCrankArgs = void;
    export type ClaimCrankResult = void;

    export interface HandleRequestArgs {
      request: __gh_codegen.swap_if$v0_1$request$SwapRequest;
    }
    export type HandleRequestResult = void;

    export interface InitializeArgs {
      factory: __gh_protocol.ContractAddress;
      token0: __gh_protocol.ContractAddress;
      token1: __gh_protocol.ContractAddress;
      lpToken: __gh_protocol.ContractAddress;
      driver: __gh_protocol.ContractAddress;
    }
    export type InitializeResult = void;

    export type PoolStateArgs = void;
    export type PoolStateResult = __gh_codegen.swap_if$v0_1$handler$PoolState;

    export interface SkimArgs {
      to: __gh_protocol.ContractAddress;
    }
    export type SkimResult = void;

    export type SyncArgs = void;
    export type SyncResult = void;

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
      name: __gh_s("SwapHandler"),
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
          name: __gh_s("claim_crank"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("handle_request"),
          args: [
            {
              name: __gh_s("request"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("swap-if"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("swap_if::request"),
                  declared: __gh_s("SwapRequest"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("factory"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token0"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token1"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("lp_token"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("driver"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("pool_state"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::handler"),
              declared: __gh_s("PoolState"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("skim"),
          args: [
            {
              name: __gh_s("to"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("sync"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
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
          module_path: __gh_s("swap_if::handler"),
          declared: __gh_s("PoolState"),
        },
        fields: [
          {
            name: __gh_s("reserves"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U128 },
                len: 2n,
              },
            },
          },
          {
            name: __gh_s("block_timestamp"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("liquidity"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("liquidity_token"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("cumulative_prices"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U256 },
                len: 2n,
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
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("AddLiquidityRequest"),
        },
        fields: [
          {
            name: __gh_s("purchaser"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("amounts_desired"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U128 },
                len: 2n,
              },
            },
          },
          {
            name: __gh_s("amounts_min"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U128 },
                len: 2n,
              },
            },
          },
          {
            name: __gh_s("recipient"),
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
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("RemoveLiquidityRequest"),
        },
        fields: [
          {
            name: __gh_s("redeemer"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("liquidity"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("amounts_min"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U128 },
                len: 2n,
              },
            },
          },
          {
            name: __gh_s("recipient"),
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
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("SwapExactInRequest"),
        },
        fields: [
          {
            name: __gh_s("trader"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("amount_in"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("amount_out_min"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("in_index"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("recipient"),
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
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("SwapExactOutRequest"),
        },
        fields: [
          {
            name: __gh_s("trader"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("amount_out"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("amount_in_max"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
          },
          {
            name: __gh_s("in_index"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("recipient"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefUnion,
      union_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("SwapOp"),
        },
        cases: [
          {
            name: __gh_s("AddLiquidity"),
            discriminant: 1n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("swap-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("swap_if::request"),
                    declared: __gh_s("AddLiquidityRequest"),
                  },
                },
              ],
            },
          },
          {
            name: __gh_s("RemoveLiquidity"),
            discriminant: 2n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("swap-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("swap_if::request"),
                    declared: __gh_s("RemoveLiquidityRequest"),
                  },
                },
              ],
            },
          },
          {
            name: __gh_s("SwapExactIn"),
            discriminant: 3n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("swap-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("swap_if::request"),
                    declared: __gh_s("SwapExactInRequest"),
                  },
                },
              ],
            },
          },
          {
            name: __gh_s("SwapExactOut"),
            discriminant: 4n,
            case_type: {
              v: __gh_contract_spec.ContractUnionCaseKind.UnionCaseTuple,
              tuple: [
                {
                  v: __gh_contract_spec.ContractTypeKind.Named,
                  named: {
                    crate_name: __gh_s("swap-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("swap_if::request"),
                    declared: __gh_s("SwapExactOutRequest"),
                  },
                },
              ],
            },
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
          module_path: __gh_s("swap_if::request"),
          declared: __gh_s("SwapRequest"),
        },
        fields: [
          {
            name: __gh_s("request_id"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("op"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Named,
              named: {
                crate_name: __gh_s("swap-if"),
                major: __gh_s("0.1"),
                module_path: __gh_s("swap_if::request"),
                declared: __gh_s("SwapOp"),
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
        declared: __gh_s("LiquidityBurnEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "3c2f1654cb81e61936b5544fd2ddec7c1ae881b4f6eca293cd21d0f3e5b999a3",
        ),
      ),
      topics: [
        {
          name: __gh_s("sender"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("recipient"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amounts_redeemed"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U128 },
              len: 2n,
            },
          },
        },
        {
          name: __gh_s("request_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("swap-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("swap_if::events"),
        declared: __gh_s("LiquidityMintEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "972c26dc446a644066cd50d95bc7523ce1dd815f505dfc28cba88e00bcc771a7",
        ),
      ),
      topics: [
        {
          name: __gh_s("sender"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("recipient"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amount_minted"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
        },
        {
          name: __gh_s("request_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("swap-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("swap_if::events"),
        declared: __gh_s("SwapEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "86b5aa1c9e00134a5f67a0206b1212775022c4ab4b5099e70602e5c1548a19ab",
        ),
      ),
      topics: [
        {
          name: __gh_s("sender"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("recipient"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amounts_in"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U128 },
              len: 2n,
            },
          },
        },
        {
          name: __gh_s("amounts_out"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U128 },
              len: 2n,
            },
          },
        },
        {
          name: __gh_s("request_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("swap-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("swap_if::events"),
        declared: __gh_s("SyncEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "15f9dd3052c289e08cbcd724168d985fe851ce3991f43b095f5b70d3a292d4bd",
        ),
      ),
      topics: [],
      fields: [
        {
          name: __gh_s("reserves"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U128 },
              len: 2n,
            },
          },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const SwapHandler = {
  v0_1: {
    claimCrank: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.ClaimCrankArgs,
      SwapHandler.v0_1.ClaimCrankResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "claim_crank",
      publicName: "claimCrank",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.claimCrank,
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
          selector: 0x947bdd51feea1ccen,
          name: "SwapRequestError",
          type: spec.interfaces[0]!.throws[2]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    handleRequest: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.HandleRequestArgs,
      SwapHandler.v0_1.HandleRequestResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "handle_request",
      publicName: "handleRequest",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.handleRequest,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "request",
          publicName: "request",
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
          selector: 0x947bdd51feea1ccen,
          name: "SwapRequestError",
          type: spec.interfaces[0]!.throws[2]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.InitializeArgs,
      SwapHandler.v0_1.InitializeResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [
        {
          abiName: "factory",
          publicName: "factory",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
        },
        {
          abiName: "token0",
          publicName: "token0",
          type: spec.interfaces[0]!.methods[2]!.args[1]!.ty,
        },
        {
          abiName: "token1",
          publicName: "token1",
          type: spec.interfaces[0]!.methods[2]!.args[2]!.ty,
        },
        {
          abiName: "lp_token",
          publicName: "lpToken",
          type: spec.interfaces[0]!.methods[2]!.args[3]!.ty,
        },
        {
          abiName: "driver",
          publicName: "driver",
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
          selector: 0x947bdd51feea1ccen,
          name: "SwapRequestError",
          type: spec.interfaces[0]!.throws[2]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    poolState: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.PoolStateArgs,
      SwapHandler.v0_1.PoolStateResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "pool_state",
      publicName: "poolState",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.poolState,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [],
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
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    skim: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.SkimArgs,
      SwapHandler.v0_1.SkimResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "skim",
      publicName: "skim",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.skim,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "to",
          publicName: "to",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
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
          selector: 0x947bdd51feea1ccen,
          name: "SwapRequestError",
          type: spec.interfaces[0]!.throws[2]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    sync: __gh_client_contract.defineContractMethod<
      SwapHandler.v0_1.SyncArgs,
      SwapHandler.v0_1.SyncResult,
      SwapHandler.v0_1.DeclaredException
    >({
      interfaceName: "SwapHandler",
      interfaceVersion: "0.1.0",
      abiName: "sync",
      publicName: "sync",
      entrypoint: __gh_entrypoints.SwapHandler.v0_1.sync,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [],
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
          selector: 0x947bdd51feea1ccen,
          name: "SwapRequestError",
          type: spec.interfaces[0]!.throws[2]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const swap_if = {
  v0_1: {
    events: {
      LiquidityBurnEvent: __gh_client_contract.defineContractEvent<
        "LiquidityBurnEvent",
        swap_if.v0_1.events.LiquidityBurnEvent["topics"],
        swap_if.v0_1.events.LiquidityBurnEvent["fields"],
        swap_if.v0_1.events.LiquidityBurnEventFilter
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
        codecs: __gh_codecs,
      }),
      LiquidityMintEvent: __gh_client_contract.defineContractEvent<
        "LiquidityMintEvent",
        swap_if.v0_1.events.LiquidityMintEvent["topics"],
        swap_if.v0_1.events.LiquidityMintEvent["fields"],
        swap_if.v0_1.events.LiquidityMintEventFilter
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
        codecs: __gh_codecs,
      }),
      SwapEvent: __gh_client_contract.defineContractEvent<
        "SwapEvent",
        swap_if.v0_1.events.SwapEvent["topics"],
        swap_if.v0_1.events.SwapEvent["fields"],
        swap_if.v0_1.events.SwapEventFilter
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
        codecs: __gh_codecs,
      }),
      SyncEvent: __gh_client_contract.defineContractEvent<
        "SyncEvent",
        swap_if.v0_1.events.SyncEvent["topics"],
        swap_if.v0_1.events.SyncEvent["fields"],
        swap_if.v0_1.events.SyncEventFilter
      >({
        name: "SyncEvent",
        signature: spec.events[3]!.signature,
        topics: [],
        fields: [{ name: "reserves", type: spec.events[3]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
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

export type SwapHandlerEvent =
  | swap_if.v0_1.events.LiquidityBurnEvent
  | swap_if.v0_1.events.LiquidityMintEvent
  | swap_if.v0_1.events.SwapEvent
  | swap_if.v0_1.events.SyncEvent;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): SwapHandlerEvent | null {
  return (
    swap_if.v0_1.events.LiquidityBurnEvent.decode(__gh_event) ??
    swap_if.v0_1.events.LiquidityMintEvent.decode(__gh_event) ??
    swap_if.v0_1.events.SwapEvent.decode(__gh_event) ??
    swap_if.v0_1.events.SyncEvent.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type swap_if$v0_1$handler$PoolState = swap_if.v0_1.handler.PoolState;
  export type swap_if$v0_1$handler$SwapLibraryError =
    swap_if.v0_1.handler.SwapLibraryError;
  export type swap_if$v0_1$handler$SwapRequestError =
    swap_if.v0_1.handler.SwapRequestError;
  export type swap_if$v0_1$pair$SwapPairError = swap_if.v0_1.pair.SwapPairError;
  export type swap_if$v0_1$request$AddLiquidityRequest =
    swap_if.v0_1.request.AddLiquidityRequest;
  export type swap_if$v0_1$request$RemoveLiquidityRequest =
    swap_if.v0_1.request.RemoveLiquidityRequest;
  export type swap_if$v0_1$request$SwapExactInRequest =
    swap_if.v0_1.request.SwapExactInRequest;
  export type swap_if$v0_1$request$SwapExactOutRequest =
    swap_if.v0_1.request.SwapExactOutRequest;
  export type swap_if$v0_1$request$SwapOp = swap_if.v0_1.request.SwapOp;
  export type swap_if$v0_1$request$SwapRequest =
    swap_if.v0_1.request.SwapRequest;
  export type thruput_erc20_if$v0_1$error$ERC20Error =
    thruput_erc20_if.v0_1.error.ERC20Error;
}
