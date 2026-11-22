import { useState, type FormEvent } from "react";
import { useClient } from "@thruputchain/react";
import { fixedBytes, toBase58 } from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import {
  reviewFactory,
  type FactoryReview,
} from "@/contracts/launchpad-client";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "@/contracts/generated/standard-token-factory";
import { ERC20 } from "@/contracts/generated/standard-token";
import { loadStandardTokenArtifact } from "@/contracts/token-artifact";
import { userErrorMessage } from "@/lib/errors";
import { useWalletTransaction } from "@/transactions/use-wallet-transaction";
import { parseTokenDraft, type ParsedToken, type TokenDraft } from "./form";

const GAS_LIMIT = gasAmount(10_000_000n);
const TokenCreated = standard_token_factory_if.v0_1.events.TokenCreated;

const initialDraft: TokenDraft = {
  name: "",
  symbol: "",
  decimals: "7",
  supply: "1000000",
};

/** What the page keeps about a launch, also after a reload. */
export interface LaunchContext {
  address: string;
  name: string;
  symbol: string;
}

export interface Review extends FactoryReview {
  nonce: Uint8Array;
  token: ParsedToken;
}

/**
 * Create a token in one transaction:
 * 1. Read the factory config, and predict the token's address from the
 *    creator and a random nonce.
 * 2. Send one atomic batch: fund the predicted address with the native tokens
 *    the factory requires, then call `create_token`. The standard token's code
 *    is deployed in the same transaction.
 * 3. Read the new address from the receipt's `TokenCreated` event.
 */
export function useLaunch(config: AppConfig) {
  const client = useClient();
  const tx = useWalletTransaction<LaunchContext>(
    `launchpad:pending:${config.networkId}:${toBase58(config.accountAddress)}`,
  );
  const [draft, setDraft] = useState(initialDraft);
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseTokenDraft(draft);

  async function reviewLaunch(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.value || tx.blocked) return;
    setReviewing(true);
    setError(null);
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const factory = await reviewFactory(client, config, nonce);
      setReview({ ...factory, nonce, token: parsed.value });
    } catch (reason) {
      setError(userErrorMessage(reason, "The factory could not be read."));
    } finally {
      setReviewing(false);
    }
  }

  async function launch() {
    if (!review) return;
    setError(null);
    try {
      const create = StandardTokenFactory.v0_1.createToken.call({
        address: config.factoryAddress,
        gasLimit: GAS_LIMIT,
        args: {
          nonce: fixedBytes(review.nonce, 32),
          administrator: config.accountAddress,
          name: review.token.name,
          symbol: review.token.symbol,
          decimals: BigInt(review.token.decimals),
          initialHolder: config.accountAddress,
          initialSupply: review.token.initialSupply,
        },
      });
      const fund = ERC20.v0_1.transfer.call({
        address: config.nativeTokenAddress,
        gasLimit: GAS_LIMIT,
        args: { receiver: review.predictedAddress, amount: review.fundingAmount },
      });
      await tx.send(
        "Launch token",
        {
          calls: review.fundingAmount > 0n ? [fund, create] : [create],
          contractsToDeploy: [
            await loadStandardTokenArtifact(config.expectedTokenHash),
          ],
        },
        {
          address: toBase58(review.predictedAddress),
          name: review.token.name,
          symbol: review.token.symbol,
        },
      );
    } catch (reason) {
      setError(userErrorMessage(reason, "The launch could not start."));
    }
  }

  const created =
    tx.completed?.succeeded === true
      ? {
          ...tx.completed.context,
          address: toBase58(
            TokenCreated.singleFromReceipt(tx.completed.receipt, {
              address: config.factoryAddress,
            }).topics.token,
          ),
        }
      : null;

  return {
    draft,
    parsed,
    submitted,
    review,
    reviewing,
    created,
    failed: tx.completed?.succeeded === false,
    error: error ?? tx.message,
    tx,
    edit(key: keyof TokenDraft, value: string) {
      setDraft((current) => ({ ...current, [key]: value }));
      setReview(null);
    },
    reviewLaunch,
    launch,
    startOver() {
      setDraft(initialDraft);
      setSubmitted(false);
      setReview(null);
      setError(null);
      tx.reset();
    },
  };
}
