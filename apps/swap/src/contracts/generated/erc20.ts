// Generated from erc20.spec.xdr — ERC20 interface v0.1.9
// Generated from erc20.spec.xdr — ERC20Metadata interface v0.1.9
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress, GasAmount, Invocation } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import { ContractTypeKind, ContractTypeDefKind, contractSpecString } from "@groundhogchain/contract-spec";
import type { ContractSpec } from "@groundhogchain/client";
import { encodeCalldata } from "@groundhogchain/client";
import { buildNamedCodecs } from "@groundhogchain/client";
import { createInvocation } from "@groundhogchain/client";
import { resolveCodec } from "@groundhogchain/client";
import { CxsReader } from "@groundhogchain/xdr";

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
} as const;

export enum ERC20Error { AlreadyInitialized = 1, MustBeContractOwner = 2, TooLarge = 3, Internal = 100, }

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("ERC20"),
      vers: s("0.1.9"),
      throws: [
        { selector: 0xb19947acb2fa14ffn, ty: { v: ContractTypeKind.Named, named: s("ERC20Error") } },
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
          args: [
          ],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("get_balance_of"),
          args: [
            { name: s("addr"), ty: { v: ContractTypeKind.Address } },
          ],
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
          args: [
          ],
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
      throws: [
      ],
      methods: [
        {
          name: s("decimals"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.U32 } },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("administrator"), ty: { v: ContractTypeKind.Address } },
            { name: s("name"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.String } } },
            { name: s("symbol"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.String } } },
            { name: s("decimals"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.U32 } } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("name"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.String } },
        },
        {
          name: s("symbol"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.String } },
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
      signature: topic(fromHex("296f450df2d1160d2c84d8e9e1361b46906b8497e3f8fbaeb9a1c2740294c6ef")),
      topics: [
        { name: s("owner"), ty: { v: ContractTypeKind.Address } },
        { name: s("spender"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("difference"), ty: { v: ContractTypeKind.I128 } },
      ],
    },
    {
      name: s("TransferEvent"),
      signature: topic(fromHex("5ff62377bf52711e75461f4d8f9b4585f17d1c20f7e1eceb280194a7764bae5f")),
      topics: [
        { name: s("from"), ty: { v: ContractTypeKind.Address } },
        { name: s("to"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("amount"), ty: { v: ContractTypeKind.I128 } },
      ],
    },
  ],
};

const namedCodecs = buildNamedCodecs(spec.type_defs);

export const ERC20 = {
  adjustAllowance(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { spender: ContractAddress; diff: bigint },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.adjustAllowance,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "adjust_allowance", [args.spender, args.diff], namedCodecs),
    });
  },
  allowance(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { owner: ContractAddress; spender: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.allowance,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "allowance", [args.owner, args.spender], namedCodecs),
    });
  },
  burn(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { owner: ContractAddress; amount: bigint },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.burn,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "burn", [args.owner, args.amount], namedCodecs),
    });
  },
  getBalance(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.getBalance,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "get_balance", [], namedCodecs),
    });
  },
  getBalanceOf(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { addr: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.getBalanceOf,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "get_balance_of", [args.addr], namedCodecs),
    });
  },
  initialize(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { administrator: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.initialize,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "initialize", [args.administrator], namedCodecs),
    });
  },
  mint(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { receiver: ContractAddress; amount: bigint },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.mint,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "mint", [args.receiver, args.amount], namedCodecs),
    });
  },
  totalSupply(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.totalSupply,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "total_supply", [], namedCodecs),
    });
  },
  transfer(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { receiver: ContractAddress; amount: bigint },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.transfer,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "transfer", [args.receiver, args.amount], namedCodecs),
    });
  },
  transferFrom(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { owner: ContractAddress; receiver: ContractAddress; amount: bigint },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20.transferFrom,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20", "transfer_from", [args.owner, args.receiver, args.amount], namedCodecs),
    });
  },
} as const;

export const ERC20Metadata = {
  decimals(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20Metadata.decimals,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20Metadata", "decimals", [], namedCodecs),
    });
  },
  initialize(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { administrator: ContractAddress; name: string | null; symbol: string | null; decimals: bigint | null },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20Metadata.initialize,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20Metadata", "initialize", [args.administrator, args.name, args.symbol, args.decimals], namedCodecs),
    });
  },
  name(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20Metadata.name,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20Metadata", "name", [], namedCodecs),
    });
  },
  symbol(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.ERC20Metadata.symbol,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "ERC20Metadata", "symbol", [], namedCodecs),
    });
  },
} as const;

function topicEquals(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ApprovalEvent {
  name: "ApprovalEvent";
  topics: { owner: Uint8Array; spender: Uint8Array; };
  fields: { difference: bigint; };
}
export const ApprovalEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("296f450df2d1160d2c84d8e9e1361b46906b8497e3f8fbaeb9a1c2740294c6ef"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): ApprovalEvent | null {
    if (!topicEquals(event.topics[0], ApprovalEvent.signature)) return null;
    if (event.topics.length !== 3) {
      throw new Error(`ApprovalEvent: expected 3 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[0].fields[0].ty, namedCodecs).decode(r) as bigint;
    if (r.remaining !== 0) {
      throw new Error(`ApprovalEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "ApprovalEvent", topics: { owner: event.topics[1], spender: event.topics[2] }, fields: { difference: f0 } };
  },
} as const;

export interface TransferEvent {
  name: "TransferEvent";
  topics: { from: Uint8Array; to: Uint8Array; };
  fields: { amount: bigint; };
}
export const TransferEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("5ff62377bf52711e75461f4d8f9b4585f17d1c20f7e1eceb280194a7764bae5f"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): TransferEvent | null {
    if (!topicEquals(event.topics[0], TransferEvent.signature)) return null;
    if (event.topics.length !== 3) {
      throw new Error(`TransferEvent: expected 3 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[1].fields[0].ty, namedCodecs).decode(r) as bigint;
    if (r.remaining !== 0) {
      throw new Error(`TransferEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "TransferEvent", topics: { from: event.topics[1], to: event.topics[2] }, fields: { amount: f0 } };
  },
} as const;

export type ERC20Event = ApprovalEvent | TransferEvent;

export function decodeEvent(event: { topics: Uint8Array[]; data: Uint8Array }): ERC20Event | null {
  return ApprovalEvent.decode(event) ?? TransferEvent.decode(event);
}
