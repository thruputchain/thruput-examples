import { bytesEqual, type TransactionReceipt } from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { swap_if } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { SeedError } from "./seed-preflight.ts";

// A successful crank alone is not proof that this liquidity request succeeded.
export function assertLiquidityMint(
  receipt: TransactionReceipt,
  handler: ContractAddress,
  requestId: Uint8Array,
  sender: ContractAddress,
  recipient: ContractAddress,
): void {
  const mints = swap_if.v0_1.events.LiquidityMintEvent.allFromReceipt(receipt, {
    address: handler,
  });
  if (
    mints.length !== 1 ||
    !mints[0]!.fields.request_id ||
    !bytesEqual(mints[0]!.fields.request_id, requestId) ||
    !bytesEqual(mints[0]!.topics.sender, sender) ||
    !bytesEqual(mints[0]!.topics.recipient, recipient) ||
    mints[0]!.fields.amount_minted <= 0n
  )
    throw new SeedError(
      "Liquidity mint not confirmed for this request; inspect the printed hashes",
    );
}
