import type { Network } from "./network";
import { fail, type SignedApproval } from "./policy";

export const MAX_APPROVALS = 16;
export const MAX_APPROVAL_BYTES = 6 * 1024 * 1024;
export const MAX_OUTGOING = 64;
export const PENDING_TRANSFER_ADVISORY =
  "Execution not yet confirmed; token contracts may need HOG storage reserve for new holders. Use Send HOG to the token address from a funded account if its reserve needs funding. Do not resubmit this transfer; use Check status to observe the original hash.";
export interface OutgoingTransfer {
  hash: string;
  account: string;
  network: Network;
  networkHash: string;
  outcome: "unknown" | "submitted" | "confirmed" | "failed";
  createdAt: number;
  advisory?: string;
}
export function replaceApproval(
  current: SignedApproval[],
  approval: SignedApproval,
): SignedApproval[] {
  const next = current.filter(
    (a) =>
      !(
        a.origin === approval.origin &&
        a.account === approval.account &&
        a.networkHash === approval.networkHash
      ),
  );
  next.push(approval);
  if (
    next.length > MAX_APPROVALS ||
    new TextEncoder().encode(JSON.stringify(next)).byteLength >
      MAX_APPROVAL_BYTES
  )
    fail(
      -32002,
      "Approval capacity reached. Submit or revoke existing approvals first.",
    );
  return next;
}
export function unresolved(record: OutgoingTransfer) {
  return record.outcome === "unknown" || record.outcome === "submitted";
}
export function assertTransferAvailable(
  records: OutgoingTransfer[],
  account: string,
  networkHash: string,
) {
  if (
    records.some(
      (r) =>
        r.account === account && r.networkHash === networkHash && unresolved(r),
    )
  )
    fail(
      -32002,
      "An outgoing transfer is unresolved. Check its status or explicitly acknowledge the duplicate-transfer risk first.",
    );
  if (records.length >= MAX_OUTGOING)
    fail(
      -32002,
      "Acknowledge old transfer records before sending another transfer.",
    );
}
