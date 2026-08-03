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

export interface U256 { _0: bigint[]; }

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
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
            { name: s("to"), ty: { v: ContractTypeKind.Address } },
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
          { name: s("_0"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U64 }, len: 4n } } },
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

export const SwapPair = {
  burnLp(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { to: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.burnLp,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "burn_lp", [args.to], namedCodecs),
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
    args: { to: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.mintLp,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "mint_lp", [args.to], namedCodecs),
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
    args: { amount0Out: bigint; amount1Out: bigint; to: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapPair.swap,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapPair", "swap", [args.amount0Out, args.amount1Out, args.to], namedCodecs),
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

export type SwapPairEvent = ApprovalEvent | TransferEvent;

export function decodeEvent(event: { topics: Uint8Array[]; data: Uint8Array }): SwapPairEvent | null {
  return ApprovalEvent.decode(event) ?? TransferEvent.decode(event);
}
