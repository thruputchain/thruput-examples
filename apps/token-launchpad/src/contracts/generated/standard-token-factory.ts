// Generated from standard_token_factory.spec.xdr - StandardTokenFactory interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import {
  ContractTypeKind,
  ContractTypeDefKind,
  contractSpecString,
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
  StandardTokenFactory: {
    config: contractEntrypointID(fromHex("49740e257d5d343e")),
    createToken: contractEntrypointID(fromHex("a844e73d3616140b")),
    creationFee: contractEntrypointID(fromHex("d81138ac5db7fd91")),
    initialize: contractEntrypointID(fromHex("11505cf753cf2025")),
    predictToken: contractEntrypointID(fromHex("60bfe6a5d280afdd")),
    requiredTokenFunding: contractEntrypointID(fromHex("77e6d53b541dde73")),
  },
} as const;

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

export interface FactoryConfig {
  token_code_hash: FixedBytes<32>;
  required_token_funding: bigint;
  native_token: ContractAddress;
  creation_fee: bigint;
  fee_recipient: ContractAddress | null;
}

export const TokenFactoryError = {
  AlreadyInitialized: 1n,
  InvalidConfig: 2n,
  InvalidTokenConfig: 3n,
  InsufficientTokenFunding: 4n,
} as const;

export type TokenFactoryError =
  (typeof TokenFactoryError)[keyof typeof TokenFactoryError];

export type StandardTokenFactoryConfigArgs = void;
export type StandardTokenFactoryConfigResult = FactoryConfig;

export interface StandardTokenFactoryCreateTokenArgs {
  nonce: FixedBytes<32>;
  administrator: ContractAddress;
  name: string | null;
  symbol: string | null;
  decimals: bigint | null;
  initialHolder: ContractAddress;
  initialSupply: bigint;
}
export type StandardTokenFactoryCreateTokenResult = ContractAddress;

export type StandardTokenFactoryCreationFeeArgs = void;
export type StandardTokenFactoryCreationFeeResult = bigint;

export interface StandardTokenFactoryInitializeArgs {
  config: FactoryConfig;
}
export type StandardTokenFactoryInitializeResult = void;

export interface StandardTokenFactoryPredictTokenArgs {
  creator: ContractAddress;
  nonce: FixedBytes<32>;
}
export type StandardTokenFactoryPredictTokenResult = ContractAddress;

export type StandardTokenFactoryRequiredTokenFundingArgs = void;
export type StandardTokenFactoryRequiredTokenFundingResult = bigint;

export type StandardTokenFactoryDeclaredException =
  | {
      kind: "declared";
      name: "ERC20Error";
      selector: 0xb19947acb2fa14ffn;
      value: ERC20Error;
    }
  | {
      kind: "declared";
      name: "TokenFactoryError";
      selector: 0xdfe28e95b625ef76n;
      value: TokenFactoryError;
    };
export type StandardTokenFactoryException =
  ContractException<StandardTokenFactoryDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("StandardTokenFactory"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
        {
          selector: 0xdfe28e95b625ef76n,
          ty: { v: ContractTypeKind.Named, named: s("TokenFactoryError") },
        },
      ],
      methods: [
        {
          name: s("config"),
          args: [],
          return_type: { v: ContractTypeKind.Named, named: s("FactoryConfig") },
        },
        {
          name: s("create_token"),
          args: [
            {
              name: s("nonce"),
              ty: {
                v: ContractTypeKind.Array,
                array: { element: { v: ContractTypeKind.U8 }, len: 32n },
              },
            },
            { name: s("administrator"), ty: { v: ContractTypeKind.Address } },
            {
              name: s("name"),
              ty: {
                v: ContractTypeKind.Option,
                option_inner: { v: ContractTypeKind.String },
              },
            },
            {
              name: s("symbol"),
              ty: {
                v: ContractTypeKind.Option,
                option_inner: { v: ContractTypeKind.String },
              },
            },
            {
              name: s("decimals"),
              ty: {
                v: ContractTypeKind.Option,
                option_inner: { v: ContractTypeKind.U32 },
              },
            },
            { name: s("initial_holder"), ty: { v: ContractTypeKind.Address } },
            { name: s("initial_supply"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("creation_fee"),
          args: [],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("initialize"),
          args: [
            {
              name: s("config"),
              ty: { v: ContractTypeKind.Named, named: s("FactoryConfig") },
            },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("predict_token"),
          args: [
            { name: s("creator"), ty: { v: ContractTypeKind.Address } },
            {
              name: s("nonce"),
              ty: {
                v: ContractTypeKind.Array,
                array: { element: { v: ContractTypeKind.U8 }, len: 32n },
              },
            },
          ],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("required_token_funding"),
          args: [],
          return_type: { v: ContractTypeKind.U128 },
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
        name: s("FactoryConfig"),
        fields: [
          {
            name: s("token_code_hash"),
            ty: {
              v: ContractTypeKind.Array,
              array: { element: { v: ContractTypeKind.U8 }, len: 32n },
            },
          },
          {
            name: s("required_token_funding"),
            ty: { v: ContractTypeKind.U128 },
          },
          { name: s("native_token"), ty: { v: ContractTypeKind.Address } },
          { name: s("creation_fee"), ty: { v: ContractTypeKind.U128 } },
          {
            name: s("fee_recipient"),
            ty: {
              v: ContractTypeKind.Option,
              option_inner: { v: ContractTypeKind.Address },
            },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("TokenFactoryError"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("InvalidConfig"), value: 2n },
          { name: s("InvalidTokenConfig"), value: 3n },
          { name: s("InsufficientTokenFunding"), value: 4n },
        ],
      },
    },
  ],
  events: [
    {
      name: s("TokenCreated"),
      signature: topic(
        fromHex(
          "dd680fc0379c6d45b2f32a7d83aad4b44cff6a895c1c580dcfb749545c213446",
        ),
      ),
      topics: [
        { name: s("token"), ty: { v: ContractTypeKind.Address } },
        { name: s("creator"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("administrator"), ty: { v: ContractTypeKind.Address } },
        { name: s("initial_holder"), ty: { v: ContractTypeKind.Address } },
        { name: s("initial_supply"), ty: { v: ContractTypeKind.U128 } },
        {
          name: s("name"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.String },
          },
        },
        {
          name: s("symbol"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.String },
          },
        },
        {
          name: s("decimals"),
          ty: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.U32 },
          },
        },
        {
          name: s("token_code_hash"),
          ty: {
            v: ContractTypeKind.Array,
            array: { element: { v: ContractTypeKind.U8 }, len: 32n },
          },
        },
      ],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const StandardTokenFactory = {
  config: defineContractMethod<
    StandardTokenFactoryConfigArgs,
    StandardTokenFactoryConfigResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "config",
    publicName: "config",
    entrypoint: entrypoints.StandardTokenFactory.config,
    args: [],
    returnType: spec.interfaces[0]!.methods[0]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  createToken: defineContractMethod<
    StandardTokenFactoryCreateTokenArgs,
    StandardTokenFactoryCreateTokenResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "create_token",
    publicName: "createToken",
    entrypoint: entrypoints.StandardTokenFactory.createToken,
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
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  creationFee: defineContractMethod<
    StandardTokenFactoryCreationFeeArgs,
    StandardTokenFactoryCreationFeeResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "creation_fee",
    publicName: "creationFee",
    entrypoint: entrypoints.StandardTokenFactory.creationFee,
    args: [],
    returnType: spec.interfaces[0]!.methods[2]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    StandardTokenFactoryInitializeArgs,
    StandardTokenFactoryInitializeResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "initialize",
    publicName: "initialize",
    entrypoint: entrypoints.StandardTokenFactory.initialize,
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
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  predictToken: defineContractMethod<
    StandardTokenFactoryPredictTokenArgs,
    StandardTokenFactoryPredictTokenResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "predict_token",
    publicName: "predictToken",
    entrypoint: entrypoints.StandardTokenFactory.predictToken,
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
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
  requiredTokenFunding: defineContractMethod<
    StandardTokenFactoryRequiredTokenFundingArgs,
    StandardTokenFactoryRequiredTokenFundingResult,
    StandardTokenFactoryDeclaredException
  >({
    interfaceName: "StandardTokenFactory",
    interfaceVersion: "0.1.0",
    abiName: "required_token_funding",
    publicName: "requiredTokenFunding",
    entrypoint: entrypoints.StandardTokenFactory.requiredTokenFunding,
    args: [],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
      {
        selector: 0xdfe28e95b625ef76n,
        name: "TokenFactoryError",
        type: spec.interfaces[0]!.throws[1]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export interface TokenCreated extends DecodedContractEvent<
  "TokenCreated",
  { token: ContractAddress; creator: ContractAddress },
  {
    administrator: ContractAddress;
    initial_holder: ContractAddress;
    initial_supply: bigint;
    name: string | null;
    symbol: string | null;
    decimals: bigint | null;
    token_code_hash: FixedBytes<32>;
  }
> {}

export interface TokenCreatedFilter {
  token?: ContractEventFilterValue<ContractAddress>;
  creator?: ContractEventFilterValue<ContractAddress>;
}

export const TokenCreated = defineContractEvent<
  "TokenCreated",
  TokenCreated["topics"],
  TokenCreated["fields"],
  TokenCreatedFilter
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
  codecs,
});

export type StandardTokenFactoryEvent = TokenCreated;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): StandardTokenFactoryEvent | null {
  return TokenCreated.decode(event);
}
