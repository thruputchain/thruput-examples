// Generated from swap_pair.spec.xdr — SwapPair interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import type { ContractAddress, GasAmount, Invocation } from "@groundhogchain/protocol";
import { contractEntrypointID, topic } from "@groundhogchain/protocol";
import { fromHex } from "@groundhogchain/protocol/utils";
import { ContractTypeKind, ContractTypeDefKind, contractSpecString, ContractUnionCaseKind } from "@groundhogchain/contract-spec";
import type { ContractSpec } from "@groundhogchain/client";
import { encodeCalldata } from "@groundhogchain/client";
import { buildNamedCodecs } from "@groundhogchain/client";
import { createInvocation } from "@groundhogchain/client";
import { resolveCodec } from "@groundhogchain/client";
import { CxsReader } from "@groundhogchain/xdr";

const s = contractSpecString;

const entrypoints = {
  SwapPair: {
    burnLp: contractEntrypointID(fromHex("705c22a562ff032c")),
    getCumulativePrices: contractEntrypointID(fromHex("2c8a7c80e2383041")),
    getLiquidity: contractEntrypointID(fromHex("bb145b14cf47ac9e")),
    getReserves: contractEntrypointID(fromHex("2e3ade09b6853122")),
    initialize: contractEntrypointID(fromHex("63bc46a73c628899")),
    liquidityToken: contractEntrypointID(fromHex("08db7a0d5d6208d6")),
    mintLp: contractEntrypointID(fromHex("a1c5ce0f66270e4a")),
    skim: contractEntrypointID(fromHex("2e5c5baceed89524")),
    swap: contractEntrypointID(fromHex("24b9993b2cc41cbb")),
    sync: contractEntrypointID(fromHex("75928f04a99454a2")),
  },
} as const;

export enum ERC20Error { AlreadyInitialized = 1, MustBeContractOwner = 2, TooLarge = 3, Internal = 100, }

export type SwapPairError =
  { case: "InitializeFailed" }
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
  | { case: "LPTokenFailure"; value: [ERC20Error] };

export interface U256 { limbs: bigint[]; }

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapPair"),
      vers: s("0.1.0"),
      throws: [
        { selector: 0x25d002d47b07640dn, ty: { v: ContractTypeKind.Named, named: s("SwapPairError") } },
        { selector: 0xb19947acb2fa14ffn, ty: { v: ContractTypeKind.Named, named: s("ERC20Error") } },
      ],
      methods: [
        {
          name: s("burn_lp"),
          args: [
            { name: s("sender"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
            { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
          ],
          return_type: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } },
        },
        {
          name: s("get_cumulative_prices"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.Named, named: s("U256") }, len: 2n } },
        },
        {
          name: s("get_liquidity"),
          args: [
          ],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("get_reserves"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Tuple, tuple: [{ v: ContractTypeKind.U128 }, { v: ContractTypeKind.U128 }, { v: ContractTypeKind.U32 }] },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("factory"), ty: { v: ContractTypeKind.Address } },
            { name: s("token0"), ty: { v: ContractTypeKind.Address } },
            { name: s("token1"), ty: { v: ContractTypeKind.Address } },
            { name: s("lp_token"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("liquidity_token"),
          args: [
          ],
          return_type: { v: ContractTypeKind.Address },
        },
        {
          name: s("mint_lp"),
          args: [
            { name: s("sender"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
            { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
          ],
          return_type: { v: ContractTypeKind.U128 },
        },
        {
          name: s("skim"),
          args: [
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("swap"),
          args: [
            { name: s("amount0_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount1_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("sender"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
            { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("sync"),
          args: [
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
            case_type: { v: ContractUnionCaseKind.UnionCaseTuple, tuple: [{ v: ContractTypeKind.Named, named: s("ERC20Error") }] },
          },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: s("U256"),
        fields: [
          { name: s("limbs"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U32 }, len: 8n } } },
        ],
      },
    },
  ],
  events: [
    {
      name: s("BurnEvent"),
      signature: topic(fromHex("44934a1f6a6a0d7c09f5464a14adefd9da1e9cde4d9420b333fecb917c47f52c")),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("amounts_redeemed"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
        { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
      ],
    },
    {
      name: s("MintEvent"),
      signature: topic(fromHex("48e990a9515a2084882012e9e7c7cf93100fd7f03be5f1665969aefe519444be")),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("amount_minted"), ty: { v: ContractTypeKind.U128 } },
        { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
      ],
    },
    {
      name: s("SwapEvent"),
      signature: topic(fromHex("86b5aa1c9e00134a5f67a0206b1212775022c4ab4b5099e70602e5c1548a19ab")),
      topics: [
        { name: s("sender"), ty: { v: ContractTypeKind.Address } },
        { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
      ],
      fields: [
        { name: s("amounts_in"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
        { name: s("amounts_out"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
        { name: s("request_id"), ty: { v: ContractTypeKind.Option, option_inner: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U8 }, len: 32n } } } },
      ],
    },
    {
      name: s("SyncEvent"),
      signature: topic(fromHex("15f9dd3052c289e08cbcd724168d985fe851ce3991f43b095f5b70d3a292d4bd")),
      topics: [
      ],
      fields: [
        { name: s("reserves"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
      ],
    },
  ],
};

const namedCodecs = buildNamedCodecs(spec.type_defs);

export const SwapPair = {
  burnLp(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { sender: ContractAddress; recipient: ContractAddress; requestId: Uint8Array | null },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.burnLp,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "burn_lp", [args.sender, args.recipient, args.requestId], namedCodecs),
    });
  },
  getCumulativePrices(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.getCumulativePrices,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "get_cumulative_prices", [], namedCodecs),
    });
  },
  getLiquidity(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.getLiquidity,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "get_liquidity", [], namedCodecs),
    });
  },
  getReserves(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.getReserves,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "get_reserves", [], namedCodecs),
    });
  },
  initialize(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { factory: ContractAddress; token0: ContractAddress; token1: ContractAddress; lpToken: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.initialize,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "initialize", [args.factory, args.token0, args.token1, args.lpToken], namedCodecs),
    });
  },
  liquidityToken(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.liquidityToken,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "liquidity_token", [], namedCodecs),
    });
  },
  mintLp(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { sender: ContractAddress; recipient: ContractAddress; requestId: Uint8Array | null },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.mintLp,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "mint_lp", [args.sender, args.recipient, args.requestId], namedCodecs),
    });
  },
  skim(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { to: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.skim,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "skim", [args.to], namedCodecs),
    });
  },
  swap(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { amount0Out: bigint; amount1Out: bigint; sender: ContractAddress; recipient: ContractAddress; requestId: Uint8Array | null },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.swap,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "swap", [args.amount0Out, args.amount1Out, args.sender, args.recipient, args.requestId], namedCodecs),
    });
  },
  sync(
    contract: ContractAddress,
    gasLimit: GasAmount,
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.sync,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "sync", [], namedCodecs),
    });
  },
} as const;

function topicEquals(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface BurnEvent {
  name: "BurnEvent";
  topics: { sender: Uint8Array; recipient: Uint8Array; };
  fields: { amounts_redeemed: bigint[]; request_id: Uint8Array | null; };
}
export const BurnEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("44934a1f6a6a0d7c09f5464a14adefd9da1e9cde4d9420b333fecb917c47f52c"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): BurnEvent | null {
    if (!topicEquals(event.topics[0], BurnEvent.signature)) return null;
    if (event.topics.length !== 3) {
      throw new Error(`BurnEvent: expected 3 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[0].fields[0].ty, namedCodecs).decode(r) as bigint[];
    const f1 = resolveCodec(spec.events[0].fields[1].ty, namedCodecs).decode(r) as Uint8Array | null;
    if (r.remaining !== 0) {
      throw new Error(`BurnEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "BurnEvent", topics: { sender: event.topics[1], recipient: event.topics[2] }, fields: { amounts_redeemed: f0, request_id: f1 } };
  },
} as const;

export interface MintEvent {
  name: "MintEvent";
  topics: { sender: Uint8Array; recipient: Uint8Array; };
  fields: { amount_minted: bigint; request_id: Uint8Array | null; };
}
export const MintEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("48e990a9515a2084882012e9e7c7cf93100fd7f03be5f1665969aefe519444be"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): MintEvent | null {
    if (!topicEquals(event.topics[0], MintEvent.signature)) return null;
    if (event.topics.length !== 3) {
      throw new Error(`MintEvent: expected 3 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[1].fields[0].ty, namedCodecs).decode(r) as bigint;
    const f1 = resolveCodec(spec.events[1].fields[1].ty, namedCodecs).decode(r) as Uint8Array | null;
    if (r.remaining !== 0) {
      throw new Error(`MintEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "MintEvent", topics: { sender: event.topics[1], recipient: event.topics[2] }, fields: { amount_minted: f0, request_id: f1 } };
  },
} as const;

export interface SwapEvent {
  name: "SwapEvent";
  topics: { sender: Uint8Array; recipient: Uint8Array; };
  fields: { amounts_in: bigint[]; amounts_out: bigint[]; request_id: Uint8Array | null; };
}
export const SwapEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("86b5aa1c9e00134a5f67a0206b1212775022c4ab4b5099e70602e5c1548a19ab"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): SwapEvent | null {
    if (!topicEquals(event.topics[0], SwapEvent.signature)) return null;
    if (event.topics.length !== 3) {
      throw new Error(`SwapEvent: expected 3 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[2].fields[0].ty, namedCodecs).decode(r) as bigint[];
    const f1 = resolveCodec(spec.events[2].fields[1].ty, namedCodecs).decode(r) as bigint[];
    const f2 = resolveCodec(spec.events[2].fields[2].ty, namedCodecs).decode(r) as Uint8Array | null;
    if (r.remaining !== 0) {
      throw new Error(`SwapEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "SwapEvent", topics: { sender: event.topics[1], recipient: event.topics[2] }, fields: { amounts_in: f0, amounts_out: f1, request_id: f2 } };
  },
} as const;

export interface SyncEvent {
  name: "SyncEvent";
  topics: {  };
  fields: { reserves: bigint[]; };
}
export const SyncEvent = {
  /** Topic-0 signature hash from the contract spec. */
  signature: fromHex("15f9dd3052c289e08cbcd724168d985fe851ce3991f43b095f5b70d3a292d4bd"),
  /** Returns null if topic 0 does not identify this event. */
  decode(event: { topics: Uint8Array[]; data: Uint8Array }): SyncEvent | null {
    if (!topicEquals(event.topics[0], SyncEvent.signature)) return null;
    if (event.topics.length !== 1) {
      throw new Error(`SyncEvent: expected 1 topics, got ${event.topics.length}`);
    }
    const r = new CxsReader(event.data);
    const f0 = resolveCodec(spec.events[3].fields[0].ty, namedCodecs).decode(r) as bigint[];
    if (r.remaining !== 0) {
      throw new Error(`SyncEvent: ${r.remaining} trailing bytes after payload`);
    }
    return { name: "SyncEvent", topics: {  }, fields: { reserves: f0 } };
  },
} as const;

export type SwapPairEvent = BurnEvent | MintEvent | SwapEvent | SyncEvent;

export function decodeEvent(event: { topics: Uint8Array[]; data: Uint8Array }): SwapPairEvent | null {
  return BurnEvent.decode(event) ?? MintEvent.decode(event) ?? SwapEvent.decode(event) ?? SyncEvent.decode(event);
}
