import { gasAmount, type ContractAddress, type Invocation } from "@groundhogchain/protocol";

import { ERC20 } from "@/contracts/generated/erc20";

const TARGET_GAS = gasAmount(10_000_000n);

export function buildTransferTarget(
  token: ContractAddress,
  receiver: ContractAddress,
  amount: bigint,
): Invocation {
  if (amount <= 0n) throw new RangeError("Transfer amount must be positive");
  return ERC20.v0_1.transfer.invocation(token, TARGET_GAS, { receiver, amount });
}
