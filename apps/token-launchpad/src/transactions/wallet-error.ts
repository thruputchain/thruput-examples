export const CONNECTION_LOST_MESSAGE =
  "Reconnect your wallet to continue this launch. Your progress is saved.";

type WalletFailureReason =
  "approvalTimeout" | "rejected" | "connectionLost" | "other";

export function walletFailure(error: unknown): {
  reason: WalletFailureReason;
  message?: string;
} {
  if (!(error instanceof Error) || !("code" in error))
    return { reason: "other" };
  if (error.code === 4100 || error.code === 4900 || error.code === 4901)
    return {
      reason: "connectionLost",
      message: CONNECTION_LOST_MESSAGE,
    };
  if (error.code === 4001) {
    if (/timed out|expired/i.test(error.message))
      return {
        reason: "approvalTimeout",
        message:
          "Wallet approval timed out. Try again to open a new request. Your token details are saved.",
      };
    return {
      reason: "rejected",
      message:
        "The wallet request was canceled. Your token details are saved. Try again when you are ready.",
    };
  }
  return { reason: "other" };
}
