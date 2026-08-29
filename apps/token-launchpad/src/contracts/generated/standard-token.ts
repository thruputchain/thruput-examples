// Generated from standard_token.spec.xdr - ERC20 interface v0.1.9
// Generated from standard_token.spec.xdr - ERC20Metadata interface v0.1.9
// Generated from standard_token.spec.xdr - StandardTokenInitializer interface v0.1.0
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
  defineContractEvent,
  type DecodedContractEvent,
  type ContractEventFilterValue,
} from "@groundhogchain/client/contract";

const s = contractSpecString;

const entrypoints = {
  ERC20: {
    adjustAllowance: contractEntrypointID(fromHex("d5acf88949a80342")),
    allowance: contractEntrypointID(fromHex("d296058ebcf260cb")),
    burn: contractEntrypointID(fromHex("54adb8f6a487253b")),
    getBalance: contractEntrypointID(fromHex("b921b642d31d7dac")),
    getBalanceOf: contractEntrypointID(fromHex("41ac95d6e06e2620")),
    initialize: contractEntrypointID(fromHex("18944c3aa4944671")),
    mint: contractEntrypointID(fromHex("f3f3bd9dede066a3")),
    totalSupply: contractEntrypointID(fromHex("2cbfcd0cb5c3f962")),
    transfer: contractEntrypointID(fromHex("63285b3523f9dc3f")),
    transferFrom: contractEntrypointID(fromHex("695be60513fcc294")),
  },
  ERC20Metadata: {
    decimals: contractEntrypointID(fromHex("d9462e42964991d0")),
    initialize: contractEntrypointID(fromHex("f65b96296d684b0b")),
    name: contractEntrypointID(fromHex("51ad51ee8a5d9dd8")),
    symbol: contractEntrypointID(fromHex("3ddac721aa5abdea")),
  },
  StandardTokenInitializer: {
    initializeFromFactory: contractEntrypointID(fromHex("f5feb15864d7a0ff")),
  },
} as const;

export const ERC20Error = {
  AlreadyInitialized: 1n,
  MustBeContractOwner: 2n,
  TooLarge: 3n,
  Internal: 100n,
} as const;

export type ERC20Error = (typeof ERC20Error)[keyof typeof ERC20Error];

export interface ERC20AdjustAllowanceArgs {
  spender: ContractAddress;
  diff: bigint;
}
export type ERC20AdjustAllowanceResult = void;

export interface ERC20AllowanceArgs {
  owner: ContractAddress;
  spender: ContractAddress;
}
export type ERC20AllowanceResult = bigint;

export interface ERC20BurnArgs {
  owner: ContractAddress;
  amount: bigint;
}
export type ERC20BurnResult = void;

export type ERC20GetBalanceArgs = void;
export type ERC20GetBalanceResult = bigint;

export interface ERC20GetBalanceOfArgs {
  addr: ContractAddress;
}
export type ERC20GetBalanceOfResult = bigint;

export interface ERC20InitializeArgs {
  administrator: ContractAddress;
}
export type ERC20InitializeResult = void;

export interface ERC20MintArgs {
  receiver: ContractAddress;
  amount: bigint;
}
export type ERC20MintResult = void;

export type ERC20TotalSupplyArgs = void;
export type ERC20TotalSupplyResult = bigint;

export interface ERC20TransferArgs {
  receiver: ContractAddress;
  amount: bigint;
}
export type ERC20TransferResult = void;

export interface ERC20TransferFromArgs {
  owner: ContractAddress;
  receiver: ContractAddress;
  amount: bigint;
}
export type ERC20TransferFromResult = void;

export type ERC20DeclaredException = {
  kind: "declared";
  name: "ERC20Error";
  selector: 0xb19947acb2fa14ffn;
  value: ERC20Error;
};
export type ERC20Exception = ContractException<ERC20DeclaredException>;

export type ERC20MetadataDecimalsArgs = void;
export type ERC20MetadataDecimalsResult = bigint | null;

export interface ERC20MetadataInitializeArgs {
  administrator: ContractAddress;
  name: string | null;
  symbol: string | null;
  decimals: bigint | null;
}
export type ERC20MetadataInitializeResult = void;

export type ERC20MetadataNameArgs = void;
export type ERC20MetadataNameResult = string | null;

export type ERC20MetadataSymbolArgs = void;
export type ERC20MetadataSymbolResult = string | null;

export type ERC20MetadataDeclaredException = never;
export type ERC20MetadataException =
  ContractException<ERC20MetadataDeclaredException>;

export interface StandardTokenInitializerInitializeFromFactoryArgs {
  administrator: ContractAddress;
  name: string | null;
  symbol: string | null;
  decimals: bigint | null;
  initialHolder: ContractAddress;
  initialSupply: bigint;
}
export type StandardTokenInitializerInitializeFromFactoryResult = void;

export type StandardTokenInitializerDeclaredException = {
  kind: "declared";
  name: "ERC20Error";
  selector: 0xb19947acb2fa14ffn;
  value: ERC20Error;
};
export type StandardTokenInitializerException =
  ContractException<StandardTokenInitializerDeclaredException>;

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("ERC20"),
      vers: s("0.1.9"),
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
      ],
      methods: [
        {
          name: s("adjust_allowance"),
          args: [
            { name: s("spender"), ty: { v: ContractTypeKind.Address } },
            { name: s("diff"), ty: { v: ContractTypeKind.I128 } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("allowance"),
          args: [
            { name: s("owner"), ty: { v: ContractTypeKind.Address } },
            { name: s("spender"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("burn"),
          args: [
            { name: s("owner"), ty: { v: ContractTypeKind.Address } },
            { name: s("amount"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("get_balance"),
          args: [],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("get_balance_of"),
          args: [{ name: s("addr"), ty: { v: ContractTypeKind.Address } }],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("administrator"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("mint"),
          args: [
            { name: s("receiver"), ty: { v: ContractTypeKind.Address } },
            { name: s("amount"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("total_supply"),
          args: [],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("transfer"),
          args: [
            { name: s("receiver"), ty: { v: ContractTypeKind.Address } },
            { name: s("amount"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("transfer_from"),
          args: [
            { name: s("owner"), ty: { v: ContractTypeKind.Address } },
            { name: s("receiver"), ty: { v: ContractTypeKind.Address } },
            { name: s("amount"), ty: { v: ContractTypeKind.U128 } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
      ],
    },
    {
      name: s("ERC20Metadata"),
      vers: s("0.1.9"),
      throws: [],
      methods: [
        {
          name: s("decimals"),
          args: [],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.U32 },
          },
        },
        {
          name: s("initialize"),
          args: [
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
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("name"),
          args: [],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.String },
          },
        },
        {
          name: s("symbol"),
          args: [],
          return_type: {
            v: ContractTypeKind.Option,
            option_inner: { v: ContractTypeKind.String },
          },
        },
      ],
    },
    {
      name: s("StandardTokenInitializer"),
      vers: s("0.1.0"),
      throws: [
        {
          selector: 0xb19947acb2fa14ffn,
          ty: { v: ContractTypeKind.Named, named: s("ERC20Error") },
        },
      ],
      methods: [
        {
          name: s("initialize_from_factory"),
          args: [
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
  ],
  events: [
    {
      name: s("ApprovalEvent"),
      signature: topic(
        fromHex(
          "296f450df2d1160d2c84d8e9e1361b46906b8497e3f8fbaeb9a1c2740294c6ef",
        ),
      ),
      topics: [
        { name: s("owner"), ty: { v: ContractTypeKind.Address } },
        { name: s("spender"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [{ name: s("difference"), ty: { v: ContractTypeKind.I128 } }],
    },
    {
      name: s("TransferEvent"),
      signature: topic(
        fromHex(
          "5ff62377bf52711e75461f4d8f9b4585f17d1c20f7e1eceb280194a7764bae5f",
        ),
      ),
      topics: [
        { name: s("from"), ty: { v: ContractTypeKind.Address } },
        { name: s("to"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [{ name: s("amount"), ty: { v: ContractTypeKind.I128 } }],
    },
  ],
};

const codecs = createContractCodecContext(spec.type_defs);

export const ERC20 = {
  adjustAllowance: defineContractMethod<
    ERC20AdjustAllowanceArgs,
    ERC20AdjustAllowanceResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.adjustAllowance,
    args: [
      {
        abiName: "spender",
        publicName: "spender",
        type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
      },
      {
        abiName: "diff",
        publicName: "diff",
        type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
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
    codecs,
  }),
  allowance: defineContractMethod<
    ERC20AllowanceArgs,
    ERC20AllowanceResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.allowance,
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
    codecs,
  }),
  burn: defineContractMethod<
    ERC20BurnArgs,
    ERC20BurnResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.burn,
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
    codecs,
  }),
  getBalance: defineContractMethod<
    ERC20GetBalanceArgs,
    ERC20GetBalanceResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.getBalance,
    args: [],
    returnType: spec.interfaces[0]!.methods[3]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  getBalanceOf: defineContractMethod<
    ERC20GetBalanceOfArgs,
    ERC20GetBalanceOfResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.getBalanceOf,
    args: [
      {
        abiName: "addr",
        publicName: "addr",
        type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[4]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  initialize: defineContractMethod<
    ERC20InitializeArgs,
    ERC20InitializeResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.initialize,
    args: [
      {
        abiName: "administrator",
        publicName: "administrator",
        type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[5]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  mint: defineContractMethod<
    ERC20MintArgs,
    ERC20MintResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.mint,
    args: [
      {
        abiName: "receiver",
        publicName: "receiver",
        type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
      },
      {
        abiName: "amount",
        publicName: "amount",
        type: spec.interfaces[0]!.methods[6]!.args[1]!.ty,
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
    codecs,
  }),
  totalSupply: defineContractMethod<
    ERC20TotalSupplyArgs,
    ERC20TotalSupplyResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.totalSupply,
    args: [],
    returnType: spec.interfaces[0]!.methods[7]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
  transfer: defineContractMethod<
    ERC20TransferArgs,
    ERC20TransferResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.transfer,
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
    codecs,
  }),
  transferFrom: defineContractMethod<
    ERC20TransferFromArgs,
    ERC20TransferFromResult,
    ERC20DeclaredException
  >({
    entrypoint: entrypoints.ERC20.transferFrom,
    args: [
      {
        abiName: "owner",
        publicName: "owner",
        type: spec.interfaces[0]!.methods[9]!.args[0]!.ty,
      },
      {
        abiName: "receiver",
        publicName: "receiver",
        type: spec.interfaces[0]!.methods[9]!.args[1]!.ty,
      },
      {
        abiName: "amount",
        publicName: "amount",
        type: spec.interfaces[0]!.methods[9]!.args[2]!.ty,
      },
    ],
    returnType: spec.interfaces[0]!.methods[9]!.return_type,
    throws: [
      {
        selector: 0xb19947acb2fa14ffn,
        name: "ERC20Error",
        type: spec.interfaces[0]!.throws[0]!.ty,
      },
    ],
    codecs,
  }),
} as const;

export const ERC20Metadata = {
  decimals: defineContractMethod<
    ERC20MetadataDecimalsArgs,
    ERC20MetadataDecimalsResult,
    ERC20MetadataDeclaredException
  >({
    entrypoint: entrypoints.ERC20Metadata.decimals,
    args: [],
    returnType: spec.interfaces[1]!.methods[0]!.return_type,
    throws: [],
    codecs,
  }),
  initialize: defineContractMethod<
    ERC20MetadataInitializeArgs,
    ERC20MetadataInitializeResult,
    ERC20MetadataDeclaredException
  >({
    entrypoint: entrypoints.ERC20Metadata.initialize,
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
    codecs,
  }),
  name: defineContractMethod<
    ERC20MetadataNameArgs,
    ERC20MetadataNameResult,
    ERC20MetadataDeclaredException
  >({
    entrypoint: entrypoints.ERC20Metadata.name,
    args: [],
    returnType: spec.interfaces[1]!.methods[2]!.return_type,
    throws: [],
    codecs,
  }),
  symbol: defineContractMethod<
    ERC20MetadataSymbolArgs,
    ERC20MetadataSymbolResult,
    ERC20MetadataDeclaredException
  >({
    entrypoint: entrypoints.ERC20Metadata.symbol,
    args: [],
    returnType: spec.interfaces[1]!.methods[3]!.return_type,
    throws: [],
    codecs,
  }),
} as const;

export const StandardTokenInitializer = {
  initializeFromFactory: defineContractMethod<
    StandardTokenInitializerInitializeFromFactoryArgs,
    StandardTokenInitializerInitializeFromFactoryResult,
    StandardTokenInitializerDeclaredException
  >({
    entrypoint: entrypoints.StandardTokenInitializer.initializeFromFactory,
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
    codecs,
  }),
} as const;

export interface ApprovalEvent extends DecodedContractEvent<
  "ApprovalEvent",
  { owner: ContractAddress; spender: ContractAddress },
  { difference: bigint }
> {}

export interface ApprovalEventFilter {
  owner?: ContractEventFilterValue<ContractAddress>;
  spender?: ContractEventFilterValue<ContractAddress>;
}

export const ApprovalEvent = defineContractEvent<
  "ApprovalEvent",
  ApprovalEvent["topics"],
  ApprovalEvent["fields"],
  ApprovalEventFilter
>({
  name: "ApprovalEvent",
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
  codecs,
});

export interface TransferEvent extends DecodedContractEvent<
  "TransferEvent",
  { from: ContractAddress; to: ContractAddress },
  { amount: bigint }
> {}

export interface TransferEventFilter {
  from?: ContractEventFilterValue<ContractAddress>;
  to?: ContractEventFilterValue<ContractAddress>;
}

export const TransferEvent = defineContractEvent<
  "TransferEvent",
  TransferEvent["topics"],
  TransferEvent["fields"],
  TransferEventFilter
>({
  name: "TransferEvent",
  signature: spec.events[1]!.signature,
  topics: [
    {
      name: "from",
      type: spec.events[1]!.topics[0]!.ty,
      representation: "address",
    },
    {
      name: "to",
      type: spec.events[1]!.topics[1]!.ty,
      representation: "address",
    },
  ],
  fields: [{ name: "amount", type: spec.events[1]!.fields[0]!.ty }],
  codecs,
});

export type ERC20Event = ApprovalEvent | TransferEvent;

export function decodeEvent(event: {
  topics: Uint8Array[];
  data: Uint8Array;
}): ERC20Event | null {
  return ApprovalEvent.decode(event) ?? TransferEvent.decode(event);
}
