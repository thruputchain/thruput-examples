// Generated from swap_router.spec.xdr — SwapRouter interface v0.1.0
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
  SwapRouter: {
    addLiquidity: contractEntrypointID(fromHex("22f5cdbafa511c21")),
    initialize: contractEntrypointID(fromHex("ea244f21cfff2c93")),
    removeLiquidity: contractEntrypointID(fromHex("03d0c974a5d1ffd3")),
    swapExactTokensForTokens: contractEntrypointID(fromHex("f2cb644718a29783")),
    swapTokensForExactTokens: contractEntrypointID(fromHex("48cafe69d7df5886")),
  },
} as const;

export enum ERC20Error { AlreadyInitialized = 1, MustBeContractOwner = 2, TooLarge = 3, Internal = 100, }

export enum SwapFactoryError { AlreadyInitialized = 1, IdenticalTokens = 2, ZeroAddress = 3, PairExists = 4, }

export enum SwapLibraryError { InsufficientAmount = 1, InsufficientLiquidity = 2, InsufficientInputAmount = 3, InsufficientOutputAmount = 4, }

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

export enum SwapRequestError { InsufficientAmountA = 1, InsufficientAmountB = 2, InsufficientOutputAmount = 3, ExcessiveInputAmount = 4, }

export const spec: ContractSpec = {
  interfaces: [
    {
      name: s("SwapRouter"),
      vers: s("0.1.0"),
      throws: [
        { selector: 0x17e7e152700d9279n, ty: { v: ContractTypeKind.Named, named: s("SwapLibraryError") } },
        { selector: 0x25d002d47b07640dn, ty: { v: ContractTypeKind.Named, named: s("SwapPairError") } },
        { selector: 0x93e5de5a4268821fn, ty: { v: ContractTypeKind.Named, named: s("SwapFactoryError") } },
        { selector: 0x947bdd51feea1ccen, ty: { v: ContractTypeKind.Named, named: s("SwapRequestError") } },
        { selector: 0xb19947acb2fa14ffn, ty: { v: ContractTypeKind.Named, named: s("ERC20Error") } },
      ],
      methods: [
        {
          name: s("add_liquidity"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
            { name: s("amounts_desired"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
            { name: s("amounts_min"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("initialize"),
          args: [
            { name: s("factory"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("remove_liquidity"),
          args: [
            { name: s("token_a"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_b"), ty: { v: ContractTypeKind.Address } },
            { name: s("liquidity"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amounts_min"), ty: { v: ContractTypeKind.Array, array: { element: { v: ContractTypeKind.U128 }, len: 2n } } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("swap_exact_tokens_for_tokens"),
          args: [
            { name: s("amount_in"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount_out_min"), ty: { v: ContractTypeKind.U128 } },
            { name: s("token_in"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_out"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
          ],
          return_type: { v: ContractTypeKind.Void },
        },
        {
          name: s("swap_tokens_for_exact_tokens"),
          args: [
            { name: s("amount_out"), ty: { v: ContractTypeKind.U128 } },
            { name: s("amount_in_max"), ty: { v: ContractTypeKind.U128 } },
            { name: s("token_in"), ty: { v: ContractTypeKind.Address } },
            { name: s("token_out"), ty: { v: ContractTypeKind.Address } },
            { name: s("recipient"), ty: { v: ContractTypeKind.Address } },
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
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapFactoryError"),
        variants: [
          { name: s("AlreadyInitialized"), value: 1n },
          { name: s("IdenticalTokens"), value: 2n },
          { name: s("ZeroAddress"), value: 3n },
          { name: s("PairExists"), value: 4n },
        ],
      },
    },
    {
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapLibraryError"),
        variants: [
          { name: s("InsufficientAmount"), value: 1n },
          { name: s("InsufficientLiquidity"), value: 2n },
          { name: s("InsufficientInputAmount"), value: 3n },
          { name: s("InsufficientOutputAmount"), value: 4n },
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
      v: ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: s("SwapRequestError"),
        variants: [
          { name: s("InsufficientAmountA"), value: 1n },
          { name: s("InsufficientAmountB"), value: 2n },
          { name: s("InsufficientOutputAmount"), value: 3n },
          { name: s("ExcessiveInputAmount"), value: 4n },
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

export const SwapRouter = {
  addLiquidity(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { tokenA: ContractAddress; tokenB: ContractAddress; amountsDesired: bigint[]; amountsMin: bigint[]; recipient: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapRouter.addLiquidity,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapRouter", "add_liquidity", [args.tokenA, args.tokenB, args.amountsDesired, args.amountsMin, args.recipient], namedCodecs),
    });
  },
  initialize(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { factory: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapRouter.initialize,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapRouter", "initialize", [args.factory], namedCodecs),
    });
  },
  removeLiquidity(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { tokenA: ContractAddress; tokenB: ContractAddress; liquidity: bigint; amountsMin: bigint[]; recipient: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapRouter.removeLiquidity,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapRouter", "remove_liquidity", [args.tokenA, args.tokenB, args.liquidity, args.amountsMin, args.recipient], namedCodecs),
    });
  },
  swapExactTokensForTokens(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { amountIn: bigint; amountOutMin: bigint; tokenIn: ContractAddress; tokenOut: ContractAddress; recipient: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapRouter.swapExactTokensForTokens,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapRouter", "swap_exact_tokens_for_tokens", [args.amountIn, args.amountOutMin, args.tokenIn, args.tokenOut, args.recipient], namedCodecs),
    });
  },
  swapTokensForExactTokens(
    contract: ContractAddress,
    gasLimit: GasAmount,
    args: { amountOut: bigint; amountInMax: bigint; tokenIn: ContractAddress; tokenOut: ContractAddress; recipient: ContractAddress },
  ): Invocation {
    return createInvocation({
      invoked_address: contract,
      entrypoint: entrypoints.SwapRouter.swapTokensForExactTokens,
      gas_limit: gasLimit,
      calldata: encodeCalldata(spec, "SwapRouter", "swap_tokens_for_exact_tokens", [args.amountOut, args.amountInMax, args.tokenIn, args.tokenOut, args.recipient], namedCodecs),
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

export type SwapRouterEvent = ApprovalEvent | TransferEvent;

export function decodeEvent(event: { topics: Uint8Array[]; data: Uint8Array }): SwapRouterEvent | null {
  return ApprovalEvent.decode(event) ?? TransferEvent.decode(event);
}
