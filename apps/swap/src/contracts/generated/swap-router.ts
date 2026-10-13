// Generated from swap_router.spec.xdr - SwapRouter interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  SwapRouter: {
    v0_1: {
      addLiquidity: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("22f5cdbafa511c21"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("ea244f21cfff2c93"),
      ),
      removeLiquidity: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("03d0c974a5d1ffd3"),
      ),
      swapExactTokensForTokens: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("f2cb644718a29783"),
      ),
      swapTokensForExactTokens: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("48cafe69d7df5886"),
      ),
    },
  },
} as const;

export namespace swap_if {
  export namespace v0_1 {
    export namespace driver {
      export type SwapDriverError = 1n | 2n | 3n | 4n;
    }

    export namespace factory {
      export type SwapFactoryError = 1n | 2n | 3n | 4n | 5n;
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

    export namespace router {
      export type SwapRouterError = 1n | 2n;
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

export namespace SwapRouter {
  export namespace v0_1 {
    export interface AddLiquidityArgs {
      tokenA: __gh_protocol.ContractAddress;
      tokenB: __gh_protocol.ContractAddress;
      amountsDesired: readonly [bigint, bigint];
      amountsMin: readonly [bigint, bigint];
      recipient: __gh_protocol.ContractAddress;
    }
    export type AddLiquidityResult = __gh_client_contract.FixedBytes<32>;

    export interface InitializeArgs {
      factory: __gh_protocol.ContractAddress;
    }
    export type InitializeResult = void;

    export interface RemoveLiquidityArgs {
      tokenA: __gh_protocol.ContractAddress;
      tokenB: __gh_protocol.ContractAddress;
      liquidity: bigint;
      amountsMin: readonly [bigint, bigint];
      recipient: __gh_protocol.ContractAddress;
    }
    export type RemoveLiquidityResult = __gh_client_contract.FixedBytes<32>;

    export interface SwapExactTokensForTokensArgs {
      amountIn: bigint;
      amountOutMin: bigint;
      tokenIn: __gh_protocol.ContractAddress;
      tokenOut: __gh_protocol.ContractAddress;
      recipient: __gh_protocol.ContractAddress;
    }
    export type SwapExactTokensForTokensResult =
      __gh_client_contract.FixedBytes<32>;

    export interface SwapTokensForExactTokensArgs {
      amountOut: bigint;
      amountInMax: bigint;
      tokenIn: __gh_protocol.ContractAddress;
      tokenOut: __gh_protocol.ContractAddress;
      recipient: __gh_protocol.ContractAddress;
    }
    export type SwapTokensForExactTokensResult =
      __gh_client_contract.FixedBytes<32>;

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
          selector: 0xb19947acb2fa14ffn;
          value: __gh_codegen.thruput_erc20_if$v0_1$error$ERC20Error;
        }
      | {
          kind: "declared";
          name: "SwapDriverError";
          selector: 0xb7f3f28894243a52n;
          value: __gh_codegen.swap_if$v0_1$driver$SwapDriverError;
        }
      | {
          kind: "declared";
          name: "SwapRouterError";
          selector: 0xb9654b95411d2dban;
          value: __gh_codegen.swap_if$v0_1$router$SwapRouterError;
        };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("SwapRouter"),
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
          selector: 0xb19947acb2fa14ffn,
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
        {
          selector: 0xb9654b95411d2dban,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("swap-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("swap_if::router"),
              declared: __gh_s("SwapRouterError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("add_liquidity"),
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
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("factory"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("remove_liquidity"),
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
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
          effect: null,
        },
        {
          name: __gh_s("swap_exact_tokens_for_tokens"),
          args: [
            {
              name: __gh_s("amount_in"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
            {
              name: __gh_s("amount_out_min"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
            {
              name: __gh_s("token_in"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_out"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("recipient"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
          effect: null,
        },
        {
          name: __gh_s("swap_tokens_for_exact_tokens"),
          args: [
            {
              name: __gh_s("amount_out"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
            {
              name: __gh_s("amount_in_max"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
            {
              name: __gh_s("token_in"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("token_out"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("recipient"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
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
          crate_name: __gh_s("swap-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("swap_if::router"),
          declared: __gh_s("SwapRouterError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("NoSuchPair"), value: 2n },
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
  events: [],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const SwapRouter = {
  v0_1: {
    addLiquidity: __gh_client_contract.defineContractMethod<
      SwapRouter.v0_1.AddLiquidityArgs,
      SwapRouter.v0_1.AddLiquidityResult,
      SwapRouter.v0_1.DeclaredException
    >({
      interfaceName: "SwapRouter",
      interfaceVersion: "0.1.0",
      abiName: "add_liquidity",
      publicName: "addLiquidity",
      entrypoint: __gh_entrypoints.SwapRouter.v0_1.addLiquidity,
      effect: spec.interfaces[0]!.methods[0]!.effect,
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
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      SwapRouter.v0_1.InitializeArgs,
      SwapRouter.v0_1.InitializeResult,
      SwapRouter.v0_1.DeclaredException
    >({
      interfaceName: "SwapRouter",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.SwapRouter.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[1]!.effect,
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
      codecs: __gh_codecs,
    }),
    removeLiquidity: __gh_client_contract.defineContractMethod<
      SwapRouter.v0_1.RemoveLiquidityArgs,
      SwapRouter.v0_1.RemoveLiquidityResult,
      SwapRouter.v0_1.DeclaredException
    >({
      interfaceName: "SwapRouter",
      interfaceVersion: "0.1.0",
      abiName: "remove_liquidity",
      publicName: "removeLiquidity",
      entrypoint: __gh_entrypoints.SwapRouter.v0_1.removeLiquidity,
      effect: spec.interfaces[0]!.methods[2]!.effect,
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
      codecs: __gh_codecs,
    }),
    swapExactTokensForTokens: __gh_client_contract.defineContractMethod<
      SwapRouter.v0_1.SwapExactTokensForTokensArgs,
      SwapRouter.v0_1.SwapExactTokensForTokensResult,
      SwapRouter.v0_1.DeclaredException
    >({
      interfaceName: "SwapRouter",
      interfaceVersion: "0.1.0",
      abiName: "swap_exact_tokens_for_tokens",
      publicName: "swapExactTokensForTokens",
      entrypoint: __gh_entrypoints.SwapRouter.v0_1.swapExactTokensForTokens,
      effect: spec.interfaces[0]!.methods[3]!.effect,
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
      codecs: __gh_codecs,
    }),
    swapTokensForExactTokens: __gh_client_contract.defineContractMethod<
      SwapRouter.v0_1.SwapTokensForExactTokensArgs,
      SwapRouter.v0_1.SwapTokensForExactTokensResult,
      SwapRouter.v0_1.DeclaredException
    >({
      interfaceName: "SwapRouter",
      interfaceVersion: "0.1.0",
      abiName: "swap_tokens_for_exact_tokens",
      publicName: "swapTokensForExactTokens",
      entrypoint: __gh_entrypoints.SwapRouter.v0_1.swapTokensForExactTokens,
      effect: spec.interfaces[0]!.methods[4]!.effect,
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
      codecs: __gh_codecs,
    }),
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
    router: {
      SwapRouterError: {
        AlreadyInitialized: 1n,
        NoSuchPair: 2n,
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

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type swap_if$v0_1$driver$SwapDriverError =
    swap_if.v0_1.driver.SwapDriverError;
  export type swap_if$v0_1$factory$SwapFactoryError =
    swap_if.v0_1.factory.SwapFactoryError;
  export type swap_if$v0_1$handler$SwapLibraryError =
    swap_if.v0_1.handler.SwapLibraryError;
  export type swap_if$v0_1$handler$SwapRequestError =
    swap_if.v0_1.handler.SwapRequestError;
  export type swap_if$v0_1$pair$SwapPairError = swap_if.v0_1.pair.SwapPairError;
  export type swap_if$v0_1$router$SwapRouterError =
    swap_if.v0_1.router.SwapRouterError;
  export type thruput_erc20_if$v0_1$error$ERC20Error =
    thruput_erc20_if.v0_1.error.ERC20Error;
}
