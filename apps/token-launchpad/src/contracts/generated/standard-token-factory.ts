// Generated from standard_token_factory.spec.xdr - StandardTokenFactory interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  StandardTokenFactory: {
    v0_1: {
      config: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("49740e257d5d343e"),
      ),
      createToken: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("a844e73d3616140b"),
      ),
      creationFee: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("d81138ac5db7fd91"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("11505cf753cf2025"),
      ),
      predictToken: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("60bfe6a5d280afdd"),
      ),
      requiredTokenFunding: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("77e6d53b541dde73"),
      ),
    },
  },
} as const;

export namespace standard_token_factory_if {
  export namespace v0_1 {
    export namespace events {
      export interface TokenCreated extends __gh_client_contract.DecodedContractEvent<
        "TokenCreated",
        {
          token: __gh_protocol.ContractAddress;
          creator: __gh_protocol.ContractAddress;
        },
        {
          administrator: __gh_protocol.ContractAddress;
          initial_holder: __gh_protocol.ContractAddress;
          initial_supply: bigint;
          name: string | null;
          symbol: string | null;
          decimals: bigint | null;
          token_code_hash: __gh_client_contract.FixedBytes<32>;
        }
      > {}

      export interface TokenCreatedFilter {
        token?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
        creator?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }
    }

    export namespace factory {
      export interface FactoryConfig {
        token_code_hash: __gh_client_contract.FixedBytes<32>;
        required_token_funding: bigint;
        native_token: __gh_protocol.ContractAddress;
        creation_fee: bigint;
        fee_recipient: __gh_protocol.ContractAddress | null;
      }

      export type TokenFactoryError = 1n | 2n | 3n | 4n;
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

export namespace StandardTokenFactory {
  export namespace v0_1 {
    export type ConfigArgs = void;
    export type ConfigResult =
      __gh_codegen.standard_token_factory_if$v0_1$factory$FactoryConfig;

    export interface CreateTokenArgs {
      nonce: __gh_client_contract.FixedBytes<32>;
      administrator: __gh_protocol.ContractAddress;
      name: string | null;
      symbol: string | null;
      decimals: bigint | null;
      initialHolder: __gh_protocol.ContractAddress;
      initialSupply: bigint;
    }
    export type CreateTokenResult = __gh_protocol.ContractAddress;

    export type CreationFeeArgs = void;
    export type CreationFeeResult = bigint;

    export interface InitializeArgs {
      config: __gh_codegen.standard_token_factory_if$v0_1$factory$FactoryConfig;
    }
    export type InitializeResult = void;

    export interface PredictTokenArgs {
      creator: __gh_protocol.ContractAddress;
      nonce: __gh_client_contract.FixedBytes<32>;
    }
    export type PredictTokenResult = __gh_protocol.ContractAddress;

    export type RequiredTokenFundingArgs = void;
    export type RequiredTokenFundingResult = bigint;

    export type DeclaredException =
      | {
          kind: "declared";
          name: "TokenFactoryError";
          selector: 0xdfe28e95b625ef76n;
          value: __gh_codegen.standard_token_factory_if$v0_1$factory$TokenFactoryError;
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
      name: __gh_s("StandardTokenFactory"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("standard-token-factory-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("standard_token_factory_if::factory"),
              declared: __gh_s("TokenFactoryError"),
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
          name: __gh_s("config"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("standard-token-factory-if"),
              major: __gh_s("0.1"),
              module_path: __gh_s("standard_token_factory_if::factory"),
              declared: __gh_s("FactoryConfig"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("create_token"),
          args: [
            {
              name: __gh_s("nonce"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
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
              ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: null,
        },
        {
          name: __gh_s("creation_fee"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.I128 },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("config"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Named,
                named: {
                  crate_name: __gh_s("standard-token-factory-if"),
                  major: __gh_s("0.1"),
                  module_path: __gh_s("standard_token_factory_if::factory"),
                  declared: __gh_s("FactoryConfig"),
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("predict_token"),
          args: [
            {
              name: __gh_s("creator"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
            {
              name: __gh_s("nonce"),
              ty: {
                v: __gh_contract_spec.ContractTypeKind.Array,
                array: {
                  element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                  len: 32n,
                },
              },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: null,
        },
        {
          name: __gh_s("required_token_funding"),
          args: [],
          return_type: { v: __gh_contract_spec.ContractTypeKind.I128 },
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
          crate_name: __gh_s("standard-token-factory-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("standard_token_factory_if::factory"),
          declared: __gh_s("FactoryConfig"),
        },
        fields: [
          {
            name: __gh_s("token_code_hash"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("required_token_funding"),
            ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
          },
          {
            name: __gh_s("native_token"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("creation_fee"),
            ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
          },
          {
            name: __gh_s("fee_recipient"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Option,
              option_inner: { v: __gh_contract_spec.ContractTypeKind.Address },
            },
          },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("standard-token-factory-if"),
          major: __gh_s("0.1"),
          module_path: __gh_s("standard_token_factory_if::factory"),
          declared: __gh_s("TokenFactoryError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("InvalidConfig"), value: 2n },
          { name: __gh_s("InvalidTokenConfig"), value: 3n },
          { name: __gh_s("InsufficientTokenFunding"), value: 4n },
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
        crate_name: __gh_s("standard-token-factory-if"),
        major: __gh_s("0.1"),
        module_path: __gh_s("standard_token_factory_if::events"),
        declared: __gh_s("TokenCreated"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "dd680fc0379c6d45b2f32a7d83aad4b44cff6a895c1c580dcfb749545c213446",
        ),
      ),
      topics: [
        {
          name: __gh_s("token"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("creator"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("administrator"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("initial_holder"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
        {
          name: __gh_s("initial_supply"),
          ty: { v: __gh_contract_spec.ContractTypeKind.I128 },
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
          name: __gh_s("token_code_hash"),
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
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const StandardTokenFactory = {
  v0_1: {
    config: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.ConfigArgs,
      StandardTokenFactory.v0_1.ConfigResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "config",
      publicName: "config",
      entrypoint: __gh_entrypoints.StandardTokenFactory.v0_1.config,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    createToken: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.CreateTokenArgs,
      StandardTokenFactory.v0_1.CreateTokenResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "create_token",
      publicName: "createToken",
      entrypoint: __gh_entrypoints.StandardTokenFactory.v0_1.createToken,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "nonce",
          publicName: "nonce",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
        {
          abiName: "administrator",
          publicName: "administrator",
          type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
        },
        {
          abiName: "name",
          publicName: "name",
          type: spec.interfaces[0]!.methods[1]!.args[2]!.ty,
        },
        {
          abiName: "symbol",
          publicName: "symbol",
          type: spec.interfaces[0]!.methods[1]!.args[3]!.ty,
        },
        {
          abiName: "decimals",
          publicName: "decimals",
          type: spec.interfaces[0]!.methods[1]!.args[4]!.ty,
        },
        {
          abiName: "initial_holder",
          publicName: "initialHolder",
          type: spec.interfaces[0]!.methods[1]!.args[5]!.ty,
        },
        {
          abiName: "initial_supply",
          publicName: "initialSupply",
          type: spec.interfaces[0]!.methods[1]!.args[6]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    creationFee: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.CreationFeeArgs,
      StandardTokenFactory.v0_1.CreationFeeResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "creation_fee",
      publicName: "creationFee",
      entrypoint: __gh_entrypoints.StandardTokenFactory.v0_1.creationFee,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.InitializeArgs,
      StandardTokenFactory.v0_1.InitializeResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.StandardTokenFactory.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [
        {
          abiName: "config",
          publicName: "config",
          type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    predictToken: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.PredictTokenArgs,
      StandardTokenFactory.v0_1.PredictTokenResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "predict_token",
      publicName: "predictToken",
      entrypoint: __gh_entrypoints.StandardTokenFactory.v0_1.predictToken,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "creator",
          publicName: "creator",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
        {
          abiName: "nonce",
          publicName: "nonce",
          type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    requiredTokenFunding: __gh_client_contract.defineContractMethod<
      StandardTokenFactory.v0_1.RequiredTokenFundingArgs,
      StandardTokenFactory.v0_1.RequiredTokenFundingResult,
      StandardTokenFactory.v0_1.DeclaredException
    >({
      interfaceName: "StandardTokenFactory",
      interfaceVersion: "0.1.0",
      abiName: "required_token_funding",
      publicName: "requiredTokenFunding",
      entrypoint:
        __gh_entrypoints.StandardTokenFactory.v0_1.requiredTokenFunding,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0xdfe28e95b625ef76n,
          name: "TokenFactoryError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
        {
          selector: 0xf63c8b1f5e7e2fe0n,
          name: "ERC20Error",
          type: spec.interfaces[0]!.throws[1]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const standard_token_factory_if = {
  v0_1: {
    events: {
      TokenCreated: __gh_client_contract.defineContractEvent<
        "TokenCreated",
        standard_token_factory_if.v0_1.events.TokenCreated["topics"],
        standard_token_factory_if.v0_1.events.TokenCreated["fields"],
        standard_token_factory_if.v0_1.events.TokenCreatedFilter
      >({
        name: "TokenCreated",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "token",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
          {
            name: "creator",
            type: spec.events[0]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [
          { name: "administrator", type: spec.events[0]!.fields[0]!.ty },
          { name: "initial_holder", type: spec.events[0]!.fields[1]!.ty },
          { name: "initial_supply", type: spec.events[0]!.fields[2]!.ty },
          { name: "name", type: spec.events[0]!.fields[3]!.ty },
          { name: "symbol", type: spec.events[0]!.fields[4]!.ty },
          { name: "decimals", type: spec.events[0]!.fields[5]!.ty },
          { name: "token_code_hash", type: spec.events[0]!.fields[6]!.ty },
        ],
        codecs: __gh_codecs,
      }),
    },
    factory: {
      TokenFactoryError: {
        AlreadyInitialized: 1n,
        InvalidConfig: 2n,
        InvalidTokenConfig: 3n,
        InsufficientTokenFunding: 4n,
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

export type StandardTokenFactoryEvent =
  standard_token_factory_if.v0_1.events.TokenCreated;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): StandardTokenFactoryEvent | null {
  return standard_token_factory_if.v0_1.events.TokenCreated.decode(__gh_event);
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type standard_token_factory_if$v0_1$factory$FactoryConfig =
    standard_token_factory_if.v0_1.factory.FactoryConfig;
  export type standard_token_factory_if$v0_1$factory$TokenFactoryError =
    standard_token_factory_if.v0_1.factory.TokenFactoryError;
  export type thruput_erc20_if$v0_1$error$ERC20Error =
    thruput_erc20_if.v0_1.error.ERC20Error;
}
