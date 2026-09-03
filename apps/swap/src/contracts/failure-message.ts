import type { TransactionReceipt } from "@groundhogchain/client";

import { ERC20 } from "@/contracts/generated/erc20";
import { SwapDriver } from "@/contracts/generated/swap-driver";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { SwapRouter } from "@/contracts/generated/swap-router";
import type { CreationStepName } from "@/transactions/creation-workflow";
import type {
  LiquidityOperation,
  LiquidityStepName,
} from "@/transactions/liquidity-operation";

export function creationFailureMessage(
  step: CreationStepName,
  receipt: TransactionReceipt,
): string | null {
  if (step === "approveFunding" || step === "approveToken0" || step === "approveToken1") {
    return decode(() => ERC20.adjustAllowance.decodeReceiptOutcome(receipt));
  }
  if (step === "createPool") {
    return decode(() => SwapFactory.createPair.decodeReceiptOutcome(receipt));
  }
  if (step === "enqueue") {
    return decode(() => SwapRouter.addLiquidity.decodeReceiptOutcome(receipt));
  }
  return decode(() => SwapDriver.processRequests.decodeReceiptOutcome(receipt));
}

export function liquidityFailureMessage(
  operation: LiquidityOperation,
  step: LiquidityStepName,
  receipt: TransactionReceipt,
): string | null {
  if (step !== "enqueue") {
    return decode(() => ERC20.adjustAllowance.decodeReceiptOutcome(receipt));
  }
  return operation.kind === "add"
    ? decode(() => SwapRouter.addLiquidity.decodeReceiptOutcome(receipt))
    : decode(() => SwapRouter.removeLiquidity.decodeReceiptOutcome(receipt));
}

export function swapFailureMessage(
  phase: "approval" | "submission" | "crank",
  receipt: TransactionReceipt,
): string | null {
  if (phase === "approval") {
    return decode(() => ERC20.adjustAllowance.decodeReceiptOutcome(receipt));
  }
  if (phase === "submission") {
    return decode(() => SwapRouter.swapExactTokensForTokens.decodeReceiptOutcome(receipt));
  }
  return decode(() => SwapDriver.processRequests.decodeReceiptOutcome(receipt));
}

function decode(read: () => unknown): string | null {
  try {
    const outcome = read();
    if (!isRecord(outcome) || outcome.kind !== "abort" || !isRecord(outcome.exception)) {
      return null;
    }
    const exception = outcome.exception;
    if (exception.kind !== "declared" || typeof exception.name !== "string") return null;
    return declaredMessage(exception.name, exception.value);
  } catch {
    return null;
  }
}

function declaredMessage(name: string, value: unknown): string {
  if (typeof value === "bigint") {
    const messages: Record<string, Record<string, string>> = {
      ERC20Error: {
        "1": "The token is already initialized.",
        "2": "The wallet is not authorized to change this token.",
        "3": "The token amount exceeds the supported range.",
        "100": "The token contract reported an internal error.",
      },
      SwapFactoryError: {
        "1": "The factory is already initialized.",
        "2": "Choose two different token contracts.",
        "3": "Token addresses cannot be zero.",
        "4": "Another account already created this pool.",
        "5": "The factory funding allowance is insufficient.",
      },
      SwapRouterError: {
        "1": "The router is already initialized.",
        "2": "The factory does not contain this pool.",
      },
      SwapDriverError: {
        "1": "The supplied gas limit is too small to process a request.",
        "2": "The driver is already initialized.",
        "3": "The driver configuration is invalid.",
        "4": "The caller is not authorized to use this driver operation.",
      },
      SwapRequestError: {
        "1": "The first token amount is below the submitted minimum.",
        "2": "The second token amount is below the submitted minimum.",
        "3": "The swap output is below the submitted minimum.",
        "4": "The swap input exceeds the submitted maximum.",
      },
      SwapLibraryError: {
        "1": "The submitted amount is insufficient.",
        "2": "The pool has insufficient liquidity.",
        "3": "The swap input amount is insufficient.",
        "4": "The swap output amount is insufficient.",
      },
    };
    return messages[name]?.[value.toString()]
      ?? `${name} rejected the transaction with code ${value}.`;
  }
  if (isRecord(value) && typeof value.case === "string") {
    return `The contract rejected the transaction: ${humanize(value.case)}.`;
  }
  return `${name} rejected the transaction.`;
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
