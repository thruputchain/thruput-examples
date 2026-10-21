# Voting

A multi-question poll contract that demonstrates caller authorization, typed
storage, exclusive writes, and mergeable `Balance` totals. Start with
[Counter](../counter/README.md), then read
[`src/implementation.rs`](src/implementation.rs) and
[`tests/test.rs`](tests/test.rs).

## Try it

From the repository root, after [setup](../../README.md#setup):

```sh
cargo test -p voting --locked
thruput build -p voting
```

Expected: eight native tests pass. The build creates
`target/thruput/voting.rv32a` and its contract specification. The
[Voting app](../../apps/voting/README.md) includes localnode tests against that
RV32 artifact, including the largest allowed poll.

## Rules

- Any wallet can create a poll. The caller becomes its sole admin.
- The admin can replace the draft definition to edit, reorder, or remove items.
- Status moves once from **Draft → Open → Closed**. Opening requires a question
  and freezes the definition. Closing is permanent.
- Each wallet, including the admin, can submit one final option per question
  while the poll is open. Questions can be answered separately.
- All questions, answers, and totals are public. Wallet identity does not prove
  person identity. This example does not implement secret ballots.

Limits are part of the ABI: 8 questions, 2–6 options per question, 160 UTF-8 bytes
per title, 96 per option, and 512 for the optional description. Blank titles,
blank options, and duplicate trimmed option text are rejected. Drafts may have
zero questions.

## Storage choices

| Data | Storage | Reason |
| --- | --- | --- |
| Poll ID allocation | `NNInt` | Creation deliberately serializes ID assignment |
| Header, question titles, options | `Map` and `Value` | Small typed entries fit the localnode's 1 KiB value limit |
| Answer per poll, wallet, question | `Value<u32>` with `set_exclusive` | Concurrent duplicate submissions cannot both commit |
| First participation per poll and wallet | Exclusive `Value<bool>` | Count a wallet once across all questions |
| Option and participant totals | `Balance` | Missing totals read as zero; different wallets' increases can merge |

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

Exercise: add a question to the lifecycle test, answer it with both wallets,
and verify that the participant count stays at two.
