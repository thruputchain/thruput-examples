import {
  addressFromBase58,
  type CoreThruputClient,
  type ContractViewOutcome,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { Voting, type voting } from "./generated/voting";
import type { AppConfig } from "../config";

export type Definition = voting.v0_1.implementation.Definition;
export type Poll = voting.v0_1.implementation.PollHeader & {
  definition: Definition;
};
export const methods = Voting.v0_1;
export const GAS = gasAmount(10_000_000n);
export const statusName = (status: Poll["status"]) =>
  ["Draft", "Open", "Closed"][Number(status)] ?? "Unknown";

function value<T>(outcome: ContractViewOutcome<T, unknown>): T {
  if (outcome.kind !== "return")
    throw new Error(
      "The poll could not be read. It may not exist on this deployment.",
    );
  return outcome.value;
}

export async function listPolls(
  client: CoreThruputClient,
  config: AppConfig,
  page: number,
) {
  const { value: count } = await methods.count.view({
    client,
    contract: config.address,
  });
  const end = count - BigInt(page * 12);
  const ids = Array.from(
    { length: Number(end < 0n ? 0n : end < 12n ? end : 12n) },
    (_, i) => end - 1n - BigInt(i),
  );
  if (!ids.length) return { count, polls: [] };
  const result = await client.readViews({
    calls: ids.map((id) =>
      methods.getPoll.viewRequest({ contract: config.address, args: { id } }),
    ),
  });
  return {
    count,
    polls: result.results.map((outcome, index) => ({
      id: ids[index]!,
      poll: value(outcome),
    })),
  };
}

export async function readPoll(
  client: CoreThruputClient,
  config: AppConfig,
  id: bigint,
  wallet?: string,
) {
  const { value: initial } = await methods.getPoll.view({
    client,
    contract: config.address,
    args: { id },
  });
  const questions =
    initial.question_count === 0n
      ? []
      : (
          await client.readViews({
            calls: Array.from(
              { length: Number(initial.question_count) },
              (_, question) =>
                methods.getQuestion.viewRequest({
                  contract: config.address,
                  args: { id, question: BigInt(question) },
                }),
            ),
          })
        ).results.map(value);
  // Keep batches small. Each question's percentages use one committed snapshot.
  const [participation, ...rows] = await Promise.all([
    methods.participantCount
      .view({ client, contract: config.address, args: { id } })
      .then((r) => [r.value]),
    ...questions.map(async (q, question) => {
      const calls = q.options.map((_, option) =>
        methods.tally.viewRequest({
          contract: config.address,
          args: { id, question: BigInt(question), option: BigInt(option) },
        }),
      );
      const answer = wallet
        ? [
            methods.answer.viewRequest({
              contract: config.address,
              args: {
                id,
                voter: addressFromBase58(wallet),
                question: BigInt(question),
              },
            }),
          ]
        : [];
      return (
        await client.readViews({ calls: [...calls, ...answer] })
      ).results.map(value);
    }),
  ]);
  const poll: Poll = {
    ...initial,
    definition: {
      title: initial.title,
      description: initial.description,
      questions,
    },
  };
  return {
    poll,
    participants: participation[0] ?? 0n,
    totals: rows.map((row, i) =>
      row.slice(0, questions[i]!.options.length).map((n) => n ?? 0n),
    ),
    answers: rows.map((row, i) =>
      wallet ? (row[questions[i]!.options.length] ?? null) : null,
    ),
  };
}

export function validateDefinition(definition: Definition): string | null {
  const length = (text: string) => new TextEncoder().encode(text).length;
  if (!definition.title.trim() || length(definition.title) > 160)
    return "Enter a poll title of 1–160 UTF-8 bytes.";
  if (length(definition.description) > 512)
    return "Keep the description within 512 UTF-8 bytes.";
  if (definition.questions.length > 8) return "Use at most 8 questions.";
  for (const question of definition.questions) {
    if (!question.title.trim() || length(question.title) > 160)
      return "Each question needs a title of 1–160 UTF-8 bytes.";
    if (question.options.length < 2 || question.options.length > 6)
      return "Each question needs 2–6 options.";
    if (question.options.some((o) => !o.trim() || length(o) > 96))
      return "Each option needs 1–96 UTF-8 bytes.";
    if (
      new Set(question.options.map((o) => o.trim())).size !==
      question.options.length
    )
      return "Options in a question must be distinct.";
  }
  return null;
}

export function percentage(count: bigint, total: bigint): string {
  return total === 0n ? "0" : (Number((count * 1000n) / total) / 10).toString();
}
