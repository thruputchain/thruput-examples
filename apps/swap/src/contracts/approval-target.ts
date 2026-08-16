import { gasAmount, type ContractAddress, type Invocation } from "@groundhogchain/protocol";

import { ERC20 } from "@/contracts/generated/erc20";

const TARGET_GAS = gasAmount(10_000_000n);

export function buildApprovalTarget(
  token: ContractAddress,
  spender: ContractAddress,
  difference: bigint,
): Invocation {
  if (difference === 0n) {
    throw new RangeError("Approval difference must not be zero");
  }
  return ERC20.adjustAllowance.invocation(token, TARGET_GAS, {
    spender,
    diff: difference,
  });
}
