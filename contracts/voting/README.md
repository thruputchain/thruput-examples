# Voting

A multi-question poll contract that demonstrates caller authorization, typed
storage, fixed-length `Array`s, exclusive writes, and mergeable `Balance`
totals. Start with [Counter](../counter/README.md).

## Run

From the repository root, after [setup](../../README.md#setup):

```sh
cargo test -p voting --locked
thruput build -p voting
```

Expected: **10 tests pass**. The build creates `target/thruput/voting.rv32a`
and its contract specification. The [Voting app](../../apps/voting/README.md)
tests that artifact on a local node, including the largest allowed poll.

## Read

1. [Contract](src/implementation.rs).
2. [Tests](tests/test.rs): the poll lifecycle, permissions, and concurrent votes.

## Rules

- Any wallet can create a poll. The caller becomes its sole admin.
- The admin can replace the draft definition to edit, reorder, or remove items.
- Status moves once from **Draft → Open → Closed**. Opening requires a question
  and freezes the definition. Closing is permanent.
- Each wallet, including the admin, can submit one final option per question
  while the poll is open. Questions can be answered separately.
- All questions, answers, and totals are public. Wallet identity does not prove
  person identity. This example does not implement secret ballots;
  [Secret ballot](../secret-ballot/README.md) does.

Limits are part of the ABI: 8 questions, 2–6 options per question, 160 UTF-8 bytes
per title, 96 per option, and 512 for the optional description. Blank titles,
blank options, and duplicate trimmed option text are rejected. Drafts may have
zero questions.

## Storage choices

| Data | Storage | Reason |
| --- | --- | --- |
| Poll ID allocation | `NNInt` | Creation deliberately serializes ID assignment |
| Header, question titles, options | `Map` and `Value` | Small typed entries fit the localnode's 1 KiB value limit |
| Per-question and per-option slots | `Array` inside `Map` | Polls and wallets are open-ended keys; questions and options are indexes below a fixed limit |
| Answer per poll, wallet, question | `Value<u32>` with `set_exclusive` | Concurrent duplicate submissions cannot both commit |
| First participation per poll and wallet | Exclusive `Value<bool>` | Count a wallet once across all questions |
| Option and participant totals | `Balance` | Missing totals read as zero; different wallets' increases can merge |

An `Array<S, N>` is laid out like a `Map<u32, S>`, but its length is part of its
type: an index at or past `N` is refused without a storage read, an unset slot
reads as missing, and the slots can be walked in order, as `get_question` does.

Draft edits retain unused slots beyond the current counts. Reads and votes
cannot access them. Later edits reuse these bounded slots. `get_poll` returns
the header; `get_question` returns one question, keeping each return small.

The app sums option counts to obtain each question's answer total. There is no
second stored answer total to maintain. `PollCreated` demonstrates an indexed
event; discovery uses `count` and `get_poll`, so no indexer database is needed.

Thruput executes against a committed snapshot. A vote racing with a close can
be accepted against the open snapshot. Once closure is committed, subsequent
votes fail. The native concurrency test checks both mergeable votes and
duplicate exclusion.

## Try a change

Add a question to the lifecycle test, answer it with both wallets, and check
that the participant count stays at two.

Next: the [Voting app](../../apps/voting/README.md).
