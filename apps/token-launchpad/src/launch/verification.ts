import { bytesEqual, type GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import {
  ERC20,
  ERC20Metadata,
  type TransferEvent as DecodedTransferEvent,
} from "@/contracts/generated/standard-token";
import type { TokenCreated as DecodedTokenCreated } from "@/contracts/generated/standard-token-factory";
import type { LaunchWorkflow } from "@/launch/workflow";

export interface TokenStateSnapshot {
  name: string | null;
  symbol: string | null;
  decimals: bigint | null;
  totalSupply: bigint;
  holderBalance: bigint;
}

export async function readAndAssessTokenState(input: {
  client: GroundhogClient;
  token: ContractAddress;
  caller: ContractAddress;
  workflow: LaunchWorkflow;
}): Promise<LaunchWorkflow["verification"]> {
  try {
    const [name, symbol, decimals, totalSupply, holderBalance] =
      await Promise.all([
        ERC20Metadata.name.view({
          client: input.client,
          contract: input.token,
          caller: input.caller,
        }),
        ERC20Metadata.symbol.view({
          client: input.client,
          contract: input.token,
          caller: input.caller,
        }),
        ERC20Metadata.decimals.view({
          client: input.client,
          contract: input.token,
          caller: input.caller,
        }),
        ERC20.totalSupply.view({
          client: input.client,
          contract: input.token,
          caller: input.caller,
        }),
        ERC20.getBalanceOf.view({
          client: input.client,
          contract: input.token,
          caller: input.caller,
          args: { addr: input.caller },
        }),
      ]);
    return assessTokenState(input.workflow, {
      name: name.value,
      symbol: symbol.value,
      decimals: decimals.value,
      totalSupply: totalSupply.value,
      holderBalance: holderBalance.value,
    });
  } catch {
    return {
      status: "incomplete",
      message:
        "Token state could not be read yet. The creation evidence is preserved.",
      totalSupply: null,
      holderBalance: null,
    };
  }
}

export function assessTokenState(
  workflow: LaunchWorkflow,
  snapshot: TokenStateSnapshot,
): LaunchWorkflow["verification"] {
  const expectedSupply = BigInt(workflow.token.initialSupply);
  const matches =
    snapshot.name === workflow.token.name &&
    snapshot.symbol === workflow.token.symbol &&
    snapshot.decimals === BigInt(workflow.token.decimals) &&
    snapshot.totalSupply === expectedSupply &&
    snapshot.holderBalance === expectedSupply;
  return {
    status: matches ? "complete" : "incomplete",
    message: matches
      ? null
      : "Creation committed, but current token state differs from the initial launch values.",
    totalSupply: snapshot.totalSupply.toString(),
    holderBalance: snapshot.holderBalance.toString(),
  };
}

export function isZeroAddress(address: ContractAddress): boolean {
  return bytesEqual(address, new Uint8Array(32));
}

export function validateCreationEvidence(input: {
  created: ContractAddress;
  predicted: ContractAddress;
  creator: ContractAddress;
  expectedTokenHash: Uint8Array;
  workflow: LaunchWorkflow;
  createdEvent: DecodedTokenCreated;
  mintEvents: DecodedTransferEvent[];
}): void {
  const event = input.createdEvent;
  if (!bytesEqual(input.created, input.predicted)) {
    throw new Error(
      "The factory returned an address that differs from the prediction",
    );
  }
  if (
    !bytesEqual(event.topics.token, input.created) ||
    !bytesEqual(event.topics.creator, input.creator) ||
    !bytesEqual(event.fields.administrator, input.creator) ||
    !bytesEqual(event.fields.initial_holder, input.creator) ||
    event.fields.initial_supply !==
      BigInt(input.workflow.token.initialSupply) ||
    event.fields.name !== input.workflow.token.name ||
    event.fields.symbol !== input.workflow.token.symbol ||
    event.fields.decimals !== BigInt(input.workflow.token.decimals) ||
    !bytesEqual(event.fields.token_code_hash, input.expectedTokenHash)
  ) {
    throw new Error(
      "The committed TokenCreated event does not match this launch",
    );
  }
  const expectedSupply = BigInt(input.workflow.token.initialSupply);
  if (
    (expectedSupply === 0n && input.mintEvents.length !== 0) ||
    (expectedSupply > 0n &&
      (input.mintEvents.length !== 1 ||
        !bytesEqual(input.mintEvents[0]!.topics.to, input.creator) ||
        !isZeroAddress(input.mintEvents[0]!.topics.from) ||
        input.mintEvents[0]!.fields.amount !== expectedSupply))
  ) {
    throw new Error("The initial mint event does not match this launch");
  }
}
