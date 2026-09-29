// Generated from standard_token.spec.xdr - ERC20 interface v0.1.42
// Generated from standard_token.spec.xdr - ERC20Metadata interface v0.1.42
// Generated from standard_token.spec.xdr - StandardTokenInitializer interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@groundhogchain/protocol";
import * as __gh_protocol_utils from "@groundhogchain/protocol/utils";
import * as __gh_contract_spec from "@groundhogchain/contract-spec";
import * as __gh_client_contract from "@groundhogchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  ERC20: {
    v0_1: {
      adjustAllowance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d5acf88949a80342"),
      ),
      allowance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d296058ebcf260cb"),
      ),
      burn: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("54adb8f6a487253b"),
      ),
      clearAllowance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("83cfc31e87b29961"),
      ),
      clearBalance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("8358b61cae8129ad"),
      ),
      getBalance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("b921b642d31d7dac"),
      ),
      getBalanceOf: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("41ac95d6e06e2620"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("18944c3aa4944671"),
      ),
      mint: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("f3f3bd9dede066a3"),
      ),
      totalSupply: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("2cbfcd0cb5c3f962"),
      ),
      transfer: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("63285b3523f9dc3f"),
      ),
      transferFrom: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("695be60513fcc294"),
      ),
    },
  },
  ERC20Metadata: {
    v0_1: {
      decimals: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d9462e42964991d0"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("f65b96296d684b0b"),
      ),
      name: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("51ad51ee8a5d9dd8"),
      ),
      symbol: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("3ddac721aa5abdea"),
      ),
    },
  },
  StandardTokenInitializer: {
    v0_1: {
      initializeFromFactory: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("f5feb15864d7a0ff"),
      ),
    },
  },
} as const;

export namespace groundhog_erc20_if {
  export namespace v0_1 {
    export namespace error {
      export type ERC20Error = 1n | 2n | 3n | 4n | 100n;
    }

    export namespace events {
      export interface AllowanceChangeEvent extends __gh_client_contract.DecodedContractEvent<
        "AllowanceChangeEvent",
        {
          owner: __gh_protocol.ContractAddress;
          spender: __gh_protocol.ContractAddress;
        },
        { difference: bigint }
      > {}

      export interface AllowanceChangeEventFilter {
        owner?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        spender?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface BurnEvent extends __gh_client_contract.DecodedContractEvent<
        "BurnEvent",
        { from: __gh_protocol.ContractAddress },
        { amount: bigint }
      > {}

      export interface BurnEventFilter {
        from?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface MintEvent extends __gh_client_contract.DecodedContractEvent<
        "MintEvent",
        { to: __gh_protocol.ContractAddress },
        { amount: bigint }
      > {}

      export interface MintEventFilter {
        to?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface TransferEvent extends __gh_client_contract.DecodedContractEvent<
        "TransferEvent",
        {
          from: __gh_protocol.ContractAddress;
          to: __gh_protocol.ContractAddress;
        },
        { amount: bigint }
      > {}

      export interface TransferEventFilter {
        from?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        to?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }
  }
}

export namespace ERC20 {
  export namespace v0_1 {
    export interface AdjustAllowanceArgs {
      spender: __gh_protocol.ContractAddress;
      difference: bigint;
      exclusive: boolean;
    }
    export type AdjustAllowanceResult = void;

    export interface AllowanceArgs {
      owner: __gh_protocol.ContractAddress;
      spender: __gh_protocol.ContractAddress;
    }
    export type AllowanceResult = bigint;

    export interface BurnArgs {
      owner: __gh_protocol.ContractAddress;
      amount: bigint;
    }
    export type BurnResult = void;

    export interface ClearAllowanceArgs {
      spender: __gh_protocol.ContractAddress;
    }
    export type ClearAllowanceResult = void;

    export type ClearBalanceArgs = void;
    export type ClearBalanceResult = void;

    export type GetBalanceArgs = void;
    export type GetBalanceResult = bigint;

    export interface GetBalanceOfArgs {
      addr: __gh_protocol.ContractAddress;
    }
    export type GetBalanceOfResult = bigint;

    export interface InitializeArgs {
      administrator: __gh_protocol.ContractAddress;
    }
    export type InitializeResult = void;

    export interface MintArgs {
      receiver: __gh_protocol.ContractAddress;
      amount: bigint;
    }
    export type MintResult = void;

    export type TotalSupplyArgs = void;
    export type TotalSupplyResult = bigint;

    export interface TransferArgs {
      receiver: __gh_protocol.ContractAddress;
      amount: bigint;
    }
    export type TransferResult = void;

    export interface TransferFromArgs {
      owner: __gh_protocol.ContractAddress;
      receiver: __gh_protocol.ContractAddress;
      amount: bigint;
    }
    export type TransferFromResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: __gh_codegen.groundhog_erc20_if$v0_1$error$ERC20Error;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export namespace ERC20Metadata {
  export namespace v0_1 {
    export type DecimalsArgs = void;
    export type DecimalsResult = bigint | null;

    export interface InitializeArgs {
      administrator: __gh_protocol.ContractAddress;
      name: string | null;
      symbol: string | null;
      decimals: bigint | null;
    }
    export type InitializeResult = void;

    export type NameArgs = void;
    export type NameResult = string | null;

    export type SymbolArgs = void;
    export type SymbolResult = string | null;

    export type DeclaredException = never;
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export namespace StandardTokenInitializer {
  export namespace v0_1 {
    export interface InitializeFromFactoryArgs {
      administrator: __gh_protocol.ContractAddress;
      name: string | null;
      symbol: string | null;
      decimals: bigint | null;
      initialHolder: __gh_protocol.ContractAddress;
      initialSupply: bigint;
    }
    export type InitializeFromFactoryResult = void;

    export type DeclaredException = {
      kind: "declared";
      name: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: __gh_codegen.groundhog_erc20_if$v0_1$error$ERC20Error;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("ERC20"),
      vers: __gh_s("0.1.42"),
      throws: [
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
      ],
      methods: [
        {
          name: __gh_s("adjust_allowance"),
          args: [
            {
              name: __gh_s("spender"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("difference"),
              ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
            },
            {
              name: __gh_s("exclusive"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("allowance"),
          args: [
            {
              name: __gh_s("owner"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("spender"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U128 },
        },
        {
          name: __gh_s("burn"),
          args: [
            {
              name: __gh_s("owner"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("clear_allowance"),
          args: [
            {
              name: __gh_s("spender"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("clear_balance"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("get_balance"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U128 },
        },
        {
          name: __gh_s("get_balance_of"),
          args: [
            {
              name: __gh_s("addr"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U128 },
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("administrator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("mint"),
          args: [
            {
              name: __gh_s("receiver"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("total_supply"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U128 },
        },
        {
          name: __gh_s("transfer"),
          args: [
            {
              name: __gh_s("receiver"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("transfer_from"),
          args: [
            {
              name: __gh_s("owner"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("receiver"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("amount"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
      ],
    },
    {
      name: __gh_s("ERC20Metadata"),
      vers: __gh_s("0.1.42"),
      throws: [],
      methods: [
        {
          name: __gh_s("decimals"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("administrator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("name"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
              },
            },
            {
              name: __gh_s("symbol"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
              },
            },
            {
              name: __gh_s("decimals"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.U32 },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
        {
          name: __gh_s("name"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
          },
        },
        {
          name: __gh_s("symbol"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
          },
        },
      ],
    },
    {
      name: __gh_s("StandardTokenInitializer"),
      vers: __gh_s("0.1.0"),
      throws: [
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
      ],
      methods: [
        {
          name: __gh_s("initialize_from_factory"),
          args: [
            {
              name: __gh_s("administrator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("name"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
              },
            },
            {
              name: __gh_s("symbol"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.String },
              },
            },
            {
              name: __gh_s("decimals"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Option,
                option_inner: { v: __gh_contract_spec.ContractTypeKind.U32 },
              },
            },
            {
              name: __gh_s("initial_holder"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("initial_supply"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
        },
      ],
    },
  ],
  type_defs: [
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
          { name: __gh_s("Internal"), value: 100n },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("groundhog-erc20-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("groundhog_erc20_if::events"),
        declared: __gh_s("AllowanceChangeEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "8f651cf72869c41d81740e5d5c083f66b7cb8c9041ab203c243c8296ac0fb050",
        ),
      ),
      topics: [
        {
          name: __gh_s("owner"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("spender"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("difference"),
          ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("groundhog-erc20-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("groundhog_erc20_if::events"),
        declared: __gh_s("BurnEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "513f00645e2752c8b6273adbbd6b0dae498cf7c4028751e05c7d8900fb4182c5",
        ),
      ),
      topics: [
        {
          name: __gh_s("from"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amount"),
          ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("groundhog-erc20-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("groundhog_erc20_if::events"),
        declared: __gh_s("MintEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "10c4493b678f7f00f19a3bbf4fa153186a2d1f4cf328a495718af7679fa54ea4",
        ),
      ),
      topics: [
        {
          name: __gh_s("to"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amount"),
          ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("groundhog-erc20-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("groundhog_erc20_if::events"),
        declared: __gh_s("TransferEvent"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "5ff62377bf52711e75461f4d8f9b4585f17d1c20f7e1eceb280194a7764bae5f",
        ),
      ),
      topics: [
        {
          name: __gh_s("from"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("to"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("amount"),
          ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const ERC20 = {
  v0_1: {
    adjustAllowance: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.AdjustAllowanceArgs,
      ERC20.v0_1.AdjustAllowanceResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "adjust_allowance",
      publicName: "adjustAllowance",
      entrypoint: __gh_entrypoints.ERC20.v0_1.adjustAllowance,
      args: [
        {
          abiName: "spender",
          publicName: "spender",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "difference",
          publicName: "difference",
          type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
        },
        {
          abiName: "exclusive",
          publicName: "exclusive",
          type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    allowance: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.AllowanceArgs,
      ERC20.v0_1.AllowanceResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "allowance",
      publicName: "allowance",
      entrypoint: __gh_entrypoints.ERC20.v0_1.allowance,
      args: [
        {
          abiName: "owner",
          publicName: "owner",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
        {
          abiName: "spender",
          publicName: "spender",
          type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    burn: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.BurnArgs,
      ERC20.v0_1.BurnResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "burn",
      publicName: "burn",
      entrypoint: __gh_entrypoints.ERC20.v0_1.burn,
      args: [
        {
          abiName: "owner",
          publicName: "owner",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[2]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    clearAllowance: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.ClearAllowanceArgs,
      ERC20.v0_1.ClearAllowanceResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "clear_allowance",
      publicName: "clearAllowance",
      entrypoint: __gh_entrypoints.ERC20.v0_1.clearAllowance,
      args: [
        {
          abiName: "spender",
          publicName: "spender",
          type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    clearBalance: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.ClearBalanceArgs,
      ERC20.v0_1.ClearBalanceResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "clear_balance",
      publicName: "clearBalance",
      entrypoint: __gh_entrypoints.ERC20.v0_1.clearBalance,
      args: [],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getBalance: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.GetBalanceArgs,
      ERC20.v0_1.GetBalanceResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "get_balance",
      publicName: "getBalance",
      entrypoint: __gh_entrypoints.ERC20.v0_1.getBalance,
      args: [],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getBalanceOf: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.GetBalanceOfArgs,
      ERC20.v0_1.GetBalanceOfResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "get_balance_of",
      publicName: "getBalanceOf",
      entrypoint: __gh_entrypoints.ERC20.v0_1.getBalanceOf,
      args: [
        {
          abiName: "addr",
          publicName: "addr",
          type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.InitializeArgs,
      ERC20.v0_1.InitializeResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.ERC20.v0_1.initialize,
      args: [
        {
          abiName: "administrator",
          publicName: "administrator",
          type: spec.interfaces[0]!.methods[7]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[7]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    mint: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.MintArgs,
      ERC20.v0_1.MintResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "mint",
      publicName: "mint",
      entrypoint: __gh_entrypoints.ERC20.v0_1.mint,
      args: [
        {
          abiName: "receiver",
          publicName: "receiver",
          type: spec.interfaces[0]!.methods[8]!.args[0]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[8]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[8]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    totalSupply: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.TotalSupplyArgs,
      ERC20.v0_1.TotalSupplyResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "total_supply",
      publicName: "totalSupply",
      entrypoint: __gh_entrypoints.ERC20.v0_1.totalSupply,
      args: [],
      returnType: spec.interfaces[0]!.methods[9]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    transfer: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.TransferArgs,
      ERC20.v0_1.TransferResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "transfer",
      publicName: "transfer",
      entrypoint: __gh_entrypoints.ERC20.v0_1.transfer,
      args: [
        {
          abiName: "receiver",
          publicName: "receiver",
          type: spec.interfaces[0]!.methods[10]!.args[0]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[10]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[10]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    transferFrom: __gh_client_contract.defineContractMethod<
      ERC20.v0_1.TransferFromArgs,
      ERC20.v0_1.TransferFromResult,
      ERC20.v0_1.DeclaredException
    >({
      interfaceName: "ERC20",
      interfaceVersion: "0.1.42",
      abiName: "transfer_from",
      publicName: "transferFrom",
      entrypoint: __gh_entrypoints.ERC20.v0_1.transferFrom,
      args: [
        {
          abiName: "owner",
          publicName: "owner",
          type: spec.interfaces[0]!.methods[11]!.args[0]!.ty,
        },
        {
          abiName: "receiver",
          publicName: "receiver",
          type: spec.interfaces[0]!.methods[11]!.args[1]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[11]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[11]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const ERC20Metadata = {
  v0_1: {
    decimals: __gh_client_contract.defineContractMethod<
      ERC20Metadata.v0_1.DecimalsArgs,
      ERC20Metadata.v0_1.DecimalsResult,
      ERC20Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC20Metadata",
      interfaceVersion: "0.1.42",
      abiName: "decimals",
      publicName: "decimals",
      entrypoint: __gh_entrypoints.ERC20Metadata.v0_1.decimals,
      args: [],
      returnType: spec.interfaces[1]!.methods[0]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      ERC20Metadata.v0_1.InitializeArgs,
      ERC20Metadata.v0_1.InitializeResult,
      ERC20Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC20Metadata",
      interfaceVersion: "0.1.42",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.ERC20Metadata.v0_1.initialize,
      args: [
        {
          abiName: "administrator",
          publicName: "administrator",
          type: spec.interfaces[1]!.methods[1]!.args[0]!.ty,
        },
        {
          abiName: "name",
          publicName: "name",
          type: spec.interfaces[1]!.methods[1]!.args[1]!.ty,
        },
        {
          abiName: "symbol",
          publicName: "symbol",
          type: spec.interfaces[1]!.methods[1]!.args[2]!.ty,
        },
        {
          abiName: "decimals",
          publicName: "decimals",
          type: spec.interfaces[1]!.methods[1]!.args[3]!.ty,
        },
      ],
      returnType: spec.interfaces[1]!.methods[1]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
    name: __gh_client_contract.defineContractMethod<
      ERC20Metadata.v0_1.NameArgs,
      ERC20Metadata.v0_1.NameResult,
      ERC20Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC20Metadata",
      interfaceVersion: "0.1.42",
      abiName: "name",
      publicName: "name",
      entrypoint: __gh_entrypoints.ERC20Metadata.v0_1.name,
      args: [],
      returnType: spec.interfaces[1]!.methods[2]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
    symbol: __gh_client_contract.defineContractMethod<
      ERC20Metadata.v0_1.SymbolArgs,
      ERC20Metadata.v0_1.SymbolResult,
      ERC20Metadata.v0_1.DeclaredException
    >({
      interfaceName: "ERC20Metadata",
      interfaceVersion: "0.1.42",
      abiName: "symbol",
      publicName: "symbol",
      entrypoint: __gh_entrypoints.ERC20Metadata.v0_1.symbol,
      args: [],
      returnType: spec.interfaces[1]!.methods[3]!.return_type,
      throws: [],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const StandardTokenInitializer = {
  v0_1: {
    initializeFromFactory: __gh_client_contract.defineContractMethod<
      StandardTokenInitializer.v0_1.InitializeFromFactoryArgs,
      StandardTokenInitializer.v0_1.InitializeFromFactoryResult,
      StandardTokenInitializer.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenInitializer",
      interfaceVersion: "0.1.0",
      abiName: "initialize_from_factory",
      publicName: "initializeFromFactory",
      entrypoint:
        __gh_entrypoints.StandardTokenInitializer.v0_1.initializeFromFactory,
      args: [
        {
          abiName: "administrator",
          publicName: "administrator",
          type: spec.interfaces[2]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "name",
          publicName: "name",
          type: spec.interfaces[2]!.methods[0]!.args[1]!.ty,
        },
        {
          abiName: "symbol",
          publicName: "symbol",
          type: spec.interfaces[2]!.methods[0]!.args[2]!.ty,
        },
        {
          abiName: "decimals",
          publicName: "decimals",
          type: spec.interfaces[2]!.methods[0]!.args[3]!.ty,
        },
        {
          abiName: "initial_holder",
          publicName: "initialHolder",
          type: spec.interfaces[2]!.methods[0]!.args[4]!.ty,
        },
        {
          abiName: "initial_supply",
          publicName: "initialSupply",
          type: spec.interfaces[2]!.methods[0]!.args[5]!.ty,
        },
      ],
      returnType: spec.interfaces[2]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          name: "ERC20Error",
          type: spec.interfaces[2]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
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
        Internal: 100n,
      },
    },
    events: {
      AllowanceChangeEvent: __gh_client_contract.defineContractEvent<
        "AllowanceChangeEvent",
        groundhog_erc20_if.v0_1.events.AllowanceChangeEvent["topics"],
        groundhog_erc20_if.v0_1.events.AllowanceChangeEvent["fields"],
        groundhog_erc20_if.v0_1.events.AllowanceChangeEventFilter
      >({
        name: "AllowanceChangeEvent",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "owner",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "spender",
            type: spec.events[0]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "difference", type: spec.events[0]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      BurnEvent: __gh_client_contract.defineContractEvent<
        "BurnEvent",
        groundhog_erc20_if.v0_1.events.BurnEvent["topics"],
        groundhog_erc20_if.v0_1.events.BurnEvent["fields"],
        groundhog_erc20_if.v0_1.events.BurnEventFilter
      >({
        name: "BurnEvent",
        signature: spec.events[1]!.signature,
        topics: [
          {
            name: "from",
            type: spec.events[1]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "amount", type: spec.events[1]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      MintEvent: __gh_client_contract.defineContractEvent<
        "MintEvent",
        groundhog_erc20_if.v0_1.events.MintEvent["topics"],
        groundhog_erc20_if.v0_1.events.MintEvent["fields"],
        groundhog_erc20_if.v0_1.events.MintEventFilter
      >({
        name: "MintEvent",
        signature: spec.events[2]!.signature,
        topics: [
          {
            name: "to",
            type: spec.events[2]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "amount", type: spec.events[2]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      TransferEvent: __gh_client_contract.defineContractEvent<
        "TransferEvent",
        groundhog_erc20_if.v0_1.events.TransferEvent["topics"],
        groundhog_erc20_if.v0_1.events.TransferEvent["fields"],
        groundhog_erc20_if.v0_1.events.TransferEventFilter
      >({
        name: "TransferEvent",
        signature: spec.events[3]!.signature,
        topics: [
          {
            name: "from",
            type: spec.events[3]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "to",
            type: spec.events[3]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "amount", type: spec.events[3]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type ERC20Event =
  | groundhog_erc20_if.v0_1.events.AllowanceChangeEvent
  | groundhog_erc20_if.v0_1.events.BurnEvent
  | groundhog_erc20_if.v0_1.events.MintEvent
  | groundhog_erc20_if.v0_1.events.TransferEvent;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): ERC20Event | null {
  return (
    groundhog_erc20_if.v0_1.events.AllowanceChangeEvent.decode(__gh_event) ??
    groundhog_erc20_if.v0_1.events.BurnEvent.decode(__gh_event) ??
    groundhog_erc20_if.v0_1.events.MintEvent.decode(__gh_event) ??
    groundhog_erc20_if.v0_1.events.TransferEvent.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type groundhog_erc20_if$v0_1$error$ERC20Error =
    groundhog_erc20_if.v0_1.error.ERC20Error;
}
