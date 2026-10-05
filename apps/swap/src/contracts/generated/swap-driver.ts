// Generated from swap_driver.spec.xdr - SwapDriver interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@groundhogchain/protocol";
import * as __gh_protocol_utils from "@groundhogchain/protocol/utils";
import * as __gh_contract_spec from "@groundhogchain/contract-spec";
import * as __gh_client_contract from "@groundhogchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  SwapDriver: {
    v0_1: {
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("5141f296502fd167"),
      ),
      processRequests: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("4f3ee265487ea6e3"),
      ),
      request: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("1a3e665ef0730c72"),
      ),
    },
  },
} as const;

export namespace batch_driver {
  export namespace v0_1 {
    export namespace events {
      export type Cause = 1n | 2n | 3n | 4n;

      export interface RequestAccepted extends __gh_client_contract.DecodedContractEvent<
        "RequestAccepted",
        { request_id: __gh_client_contract.FixedBytes<32> },
        {}
      > {}

      export interface RequestAcceptedFilter {
        request_id?: __gh_client_contract.ContractEventFilterValue<
          __gh_client_contract.FixedBytes<32>
        >;
      }

      export interface RequestFailed extends __gh_client_contract.DecodedContractEvent<
        "RequestFailed",
        { request_id: __gh_client_contract.FixedBytes<32> },
        {
          cause: __gh_codegen.batch_driver$v0_1$events$Cause;
          selector: bigint;
          payload: globalThis.Uint8Array;
          payload_len: bigint;
        }
      > {}

      export interface RequestFailedFilter {
        request_id?: __gh_client_contract.ContractEventFilterValue<
          __gh_client_contract.FixedBytes<32>
        >;
      }

      export interface RequestsProcessed extends __gh_client_contract.DecodedContractEvent<
        "RequestsProcessed",
        {},
        { processed: bigint; failed: bigint }
      > {}

      export type RequestsProcessedFilter = globalThis.Record<string, never>;
    }
  }
}

export namespace groundhog_erc20_if {
  export namespace v0_1 {
    export namespace error {
      export type ERC20Error = 1n | 2n | 3n | 4n | 5n | 100n;
    }
  }
}

export namespace swap_if {
  export namespace v0_1 {
    export namespace driver {
      export type SwapDriverError = 1n | 2n | 3n | 4n;
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
              __gh_codegen.groundhog_erc20_if$v0_1$error$ERC20Error,
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

export namespace SwapDriver {
  export namespace v0_1 {
    export interface InitializeArgs {
      handler: __gh_protocol.ContractAddress;
      router: __gh_protocol.ContractAddress;
      maxQueueLen: bigint;
      minCrankBatch: bigint;
    }
    export type InitializeResult = void;

    export type ProcessRequestsArgs = void;
    export type ProcessRequestsResult = readonly [bigint, bigint];

    export interface RequestArgs {
      request: __gh_codegen.swap_if$v0_1$request$SwapRequest;
    }
    export type RequestResult = __gh_client_contract.FixedBytes<32>;

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
          selector: 0xb19947acb2fa14ffn;
          value: __gh_codegen.groundhog_erc20_if$v0_1$error$ERC20Error;
        }
      | {
          kind: "declared";
          name: "SwapDriverError";
          selector: 0xb7f3f28894243a52n;
          value: __gh_codegen.swap_if$v0_1$driver$SwapDriverError;
        };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("SwapDriver"),
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
          selector: 0xb19947acb2fa14ffn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("groundhog-erc20-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("groundhog_erc20_if::error"),
              declared: __gh_s("ERC20Error"),
            },
          },
        },
        {
          selector: 0xb7f3f28894243a52n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::driver"),
              declared: __gh_s("SwapDriverError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("handler"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("router"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("max_queue_len"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("min_crank_batch"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("process_requests"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Tuple,
            tuple: [
              { v: __gh_contract_spec.ContractTypeKind.U32 },
              { v: __gh_contract_spec.ContractTypeKind.U32 },
            ],
          },
        },
        {
          name: __gh_s("request"),
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
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("batch-driver"),
          major: __gh_s("0.1"),
          module_path: __gh_s("batch_driver::events"),
          declared: __gh_s("Cause"),
        },
        variants: [
          { name: __gh_s("Exception"), value: 1n },
          { name: __gh_s("Fault"), value: 2n },
          { name: __gh_s("Rejected"), value: 3n },
          { name: __gh_s("Malformed"), value: 4n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("groundhog-erc20-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("groundhog_erc20_if::error"),
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
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::driver"),
          declared: __gh_s("SwapDriverError"),
        },
        variants: [
          { name: __gh_s("BatchTooSmall"), value: 1n },
          { name: __gh_s("AlreadyInitialized"), value: 2n },
          { name: __gh_s("InvalidConfiguration"), value: 3n },
          { name: __gh_s("Unauthorized"), value: 4n },
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
                    crate_name: __gh_s("groundhog-erc20-if"),
                    major: __gh_s("0.1"),
                    module_path: __gh_s("groundhog_erc20_if::error"),
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
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("batch-driver"),
        major: __gh_s("0.1"),
        module_path: __gh_s("batch_driver::events"),
        declared: __gh_s("RequestAccepted"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "923dee82bb3fafeed2fff1a9a9a07f2e4ff296bfebfe73c0ebc8405a9f09d818",
        ),
      ),
      topics: [
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
      ],
      fields: [],
    },
    {
      name: {
        crate_name: __gh_s("batch-driver"),
        major: __gh_s("0.1"),
        module_path: __gh_s("batch_driver::events"),
        declared: __gh_s("RequestFailed"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "2658275650fee240216d7bbd388f183cedbbfe8182198d09857fb836f0e2a5fd",
        ),
      ),
      topics: [
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
      ],
      fields: [
        {
          name: __gh_s("cause"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("batch-driver"),
              major: __gh_s("0.1"),
              module_path: __gh_s("batch_driver::events"),
              declared: __gh_s("Cause"),
            },
          },
        },
        {
          name: __gh_s("selector"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("payload"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Vector,
            vector: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              max_len: 4294967295n,
            },
          },
        },
        {
          name: __gh_s("payload_len"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("batch-driver"),
        major: __gh_s("0.1"),
        module_path: __gh_s("batch_driver::events"),
        declared: __gh_s("RequestsProcessed"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "af935ed73c377e2fdd245da79dd3585bd4b5a41897c99590b23d127ade6f324c",
        ),
      ),
      topics: [],
      fields: [
        {
          name: __gh_s("processed"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
        {
          name: __gh_s("failed"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const SwapDriver = {
  v0_1: {
    initialize: __gh_client_contract.defineContractMethod<
      SwapDriver.v0_1.InitializeArgs,
      SwapDriver.v0_1.InitializeResult,
      SwapDriver.v0_1.DeclaredException
    >({
      interfaceName: "SwapDriver",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.SwapDriver.v0_1.initialize,
      args: [
        {
          abiName: "handler",
          publicName: "handler",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "router",
          publicName: "router",
          type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
        },
        {
          abiName: "max_queue_len",
          publicName: "maxQueueLen",
          type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
        },
        {
          abiName: "min_crank_batch",
          publicName: "minCrankBatch",
          type: spec.interfaces[0]!.methods[0]!.args[3]!.ty,
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
        {
          selector: 0xb7f3f28894243a52n,
          name: "SwapDriverError",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    processRequests: __gh_client_contract.defineContractMethod<
      SwapDriver.v0_1.ProcessRequestsArgs,
      SwapDriver.v0_1.ProcessRequestsResult,
      SwapDriver.v0_1.DeclaredException
    >({
      interfaceName: "SwapDriver",
      interfaceVersion: "0.1.0",
      abiName: "process_requests",
      publicName: "processRequests",
      entrypoint: __gh_entrypoints.SwapDriver.v0_1.processRequests,
      args: [],
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
        {
          selector: 0xb7f3f28894243a52n,
          name: "SwapDriverError",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    request: __gh_client_contract.defineContractMethod<
      SwapDriver.v0_1.RequestArgs,
      SwapDriver.v0_1.RequestResult,
      SwapDriver.v0_1.DeclaredException
    >({
      interfaceName: "SwapDriver",
      interfaceVersion: "0.1.0",
      abiName: "request",
      publicName: "request",
      entrypoint: __gh_entrypoints.SwapDriver.v0_1.request,
      args: [
        {
          abiName: "request",
          publicName: "request",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
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
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[3]!.ty,
        },
        {
          selector: 0xb7f3f28894243a52n,
          name: "SwapDriverError",
          type: spec.interfaces[0]!.throws[4]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const batch_driver = {
  v0_1: {
    events: {
      Cause: {
        Exception: 1n,
        Fault: 2n,
        Rejected: 3n,
        Malformed: 4n,
      },
      RequestAccepted: __gh_client_contract.defineContractEvent<
        "RequestAccepted",
        batch_driver.v0_1.events.RequestAccepted["topics"],
        batch_driver.v0_1.events.RequestAccepted["fields"],
        batch_driver.v0_1.events.RequestAcceptedFilter
      >({
        name: "RequestAccepted",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "request_id",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "fixedBytes32",
          },
        ],
        fields: [],
        codecs: __gh_codecs,
      }),
      RequestFailed: __gh_client_contract.defineContractEvent<
        "RequestFailed",
        batch_driver.v0_1.events.RequestFailed["topics"],
        batch_driver.v0_1.events.RequestFailed["fields"],
        batch_driver.v0_1.events.RequestFailedFilter
      >({
        name: "RequestFailed",
        signature: spec.events[1]!.signature,
        topics: [
          {
            name: "request_id",
            type: spec.events[1]!.topics[0]!.ty,
            representation: "fixedBytes32",
          },
        ],
        fields: [
          { name: "cause", type: spec.events[1]!.fields[0]!.ty },
          { name: "selector", type: spec.events[1]!.fields[1]!.ty },
          { name: "payload", type: spec.events[1]!.fields[2]!.ty },
          { name: "payload_len", type: spec.events[1]!.fields[3]!.ty },
        ],
        codecs: __gh_codecs,
      }),
      RequestsProcessed: __gh_client_contract.defineContractEvent<
        "RequestsProcessed",
        batch_driver.v0_1.events.RequestsProcessed["topics"],
        batch_driver.v0_1.events.RequestsProcessed["fields"],
        batch_driver.v0_1.events.RequestsProcessedFilter
      >({
        name: "RequestsProcessed",
        signature: spec.events[2]!.signature,
        topics: [],
        fields: [
          { name: "processed", type: spec.events[2]!.fields[0]!.ty },
          { name: "failed", type: spec.events[2]!.fields[1]!.ty },
        ],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export const groundhog_erc20_if = {
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

export const swap_if = {
  v0_1: {
    driver: {
      SwapDriverError: {
        BatchTooSmall: 1n,
        AlreadyInitialized: 2n,
        InvalidConfiguration: 3n,
        Unauthorized: 4n,
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

export type SwapDriverEvent =
  | batch_driver.v0_1.events.RequestAccepted
  | batch_driver.v0_1.events.RequestFailed
  | batch_driver.v0_1.events.RequestsProcessed;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): SwapDriverEvent | null {
  return (
    batch_driver.v0_1.events.RequestAccepted.decode(__gh_event) ??
    batch_driver.v0_1.events.RequestFailed.decode(__gh_event) ??
    batch_driver.v0_1.events.RequestsProcessed.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type batch_driver$v0_1$events$Cause = batch_driver.v0_1.events.Cause;
  export type groundhog_erc20_if$v0_1$error$ERC20Error =
    groundhog_erc20_if.v0_1.error.ERC20Error;
  export type swap_if$v0_1$driver$SwapDriverError =
    swap_if.v0_1.driver.SwapDriverError;
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
}
