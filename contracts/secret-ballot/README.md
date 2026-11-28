# Secret ballot: votes nobody can read, counted in the open

A poll whose ballots are encrypted. Each voter encrypts a ballot to the poll's
key and proves, in zero knowledge, that it chooses exactly one option. The
contract checks the proofs and keeps only the ciphertexts. Anyone can add the
ciphertexts up without reading them, and the trustees decrypt only the totals.
Nobody, the contract included, ever sees how any one voter voted. The poll still
proves, on chain, that the published counts are what the ballots add up to.

What makes this a Thruput example:

- **The proofs are checked in the contract.** The runtime adds up multiples of
  Ristretto255 points in one syscall, `ristretto255_msm`, for about 13,500 gas a
  term. A four-option ballot's proofs come to 18 such sums, about 1.4M gas,
  against a cap of 1,000M a transaction. On most chains, checks like these mean
  a precompile for this curve, or a SNARK.
- **No ballot waits for another.** A ballot writes its voter's own flag, an entry
  in a ballot box, and a turnout that merges. A box is a retro-causal queue
  (`RCQ`), whose inserts commute. One queue takes 250 entries a block, so the
  poll has eight boxes, its *polling stations*, and takes up to 2,000 ballots a
  block.
- **Counting is adding, and anyone can do it.** Adding ciphertexts adds what
  they hide, so a running total reveals nothing until every trustee helps
  decrypt it. The stations are counted apart, in parallel, while voting goes on,
  and their totals are added together at the end.

The [Voting](../voting/README.md) example's tallies are public. Read it first,
and [Counter](../counter/README.md) before that.

## Run

Complete the [setup](../../README.md#setup).
From the repo root, without a node or npm:

```sh
cargo test -p secret-ballot --locked --test test
```

Expected: **18 tests pass**:

- Six voters choose among three places, and the poll publishes 2, 3 and 1.
- 260 ballots land in one block. A box takes 250 a block, and the rest land at
  another station. A count takes 250 at most; the rest wait for the next block.
- All eight stations count in one block. Two counts of one station in a block
  cannot both commit.
- A ballot for two options, or none, is refused. So is a ballot with two votes for
  one option and minus one for another, whose votes still add up to one.
- A ballot copied from another voter is refused. A voter votes once.
- A trustee must prove it knows its key's secret, so that no trustee can
  submit a key that cancels the others out.
- Anyone can count while voting goes on. The count finishes only after the
  close, once every box is empty.
- A trustee's share must be honest, and only the true counts can be published.
- A trustee who withholds its share loses its bond. A poll that never opens
  gives every bond back. A poll with every share in cannot fail.
- A poll nobody votes in publishes zeroes. The admin has no say once the poll
  opens. Bad terms are refused. The contract's scalar arithmetic agrees with
  `curve25519-dalek`'s.
- Under the network's default storage prices, the poll's float of native
  tokens sets how many ballots a block can take.

Expected exceptions can appear in the output; the final result is what
determines success.

With the CLI installed, `thruput test -p secret-ballot` builds the contract and
runs the largest poll in the RV32 guest: four options, seven trustees, and a
full batch of 250 ballots in one station, counted by one call.

## How it works

A voter's choice of option 1 out of 3 is the vector (0, 1, 0). Each number `m`
is encrypted on its own, with fresh randomness `r`, as a pair of points:

```text
a = r·G        b = m·G + r·Y
```

`G` is the group's generator and `Y` the poll's key. `Y` is the sum of the
trustees' keys, `Y = x₁·G + … + xₙ·G`, and each trustee knows only its own `xᵢ`.
Reading `m` takes `r·Y`, which takes either the voter's `r` or every trustee's
`xᵢ`.

The scheme is ElGamal "in the exponent", and its ciphertexts add: the sum of
encryptions of `m₁` and `m₂` encrypts `m₁ + m₂`. So adding every ballot's
ciphertext for an option gives an encryption of how many ballots chose it.

From [the first test](tests/test.rs): six ballots, for options 0, 1, 1, 2, 1 and
0. Each ballot is three ciphertexts and four proofs:

| Proof | It shows | Checked by |
| --- | --- | --- |
| One for each option | The ciphertext encrypts 0 or 1 | [`is_bit`](src/proofs.rs) |
| One for the ballot | The three add up to an encryption of 1 | [`is_one_choice`](src/proofs.rs) |

The count adds the ciphertexts up, option by option, into a total `(A, B)` for
each. Each trustee then publishes `Dᵢ = xᵢ·A`, with a proof that it used the same
`xᵢ` as in its key ([`is_share`](src/proofs.rs)). With every share in,
`B − D₁ − … − Dₙ` is `n·G` for the count `n`. A count is no larger than the
turnout, so anyone can find it by trying 0, 1, 2, … in turn. `publish` checks the
counts it is given, 2, 3 and 1, against the totals.

Each proof is a sigma protocol made non-interactive with a Fiat–Shamir hash. The
hash covers the kind of proof, the poll's address, whom the proof is for, the
statement, and the prover's commitments: see [`Transcript`](src/group.rs). The
contract never multiplies scalars. It adds and negates them, and leaves every
point operation to the runtime: see [`group.rs`](src/group.rs).

## The steps

| Phase | Who | Calls |
| --- | --- | --- |
| Setup | The admin, who deploys the poll | `initialize(paper, terms)`, `register(voters)`, then `open()` |
| | Each trustee | `submit_key(key, proof)`, which deposits its bond |
| Voting, until `close` | Each registered voter | `cast(station, ballot)` |
| | Anyone, from the opening | `count(station)` |
| Counted | Anyone, after `close` and once every box is empty | `finish_count()` |
| | Each trustee, within `decrypt_window` | `decrypt(shares)` |
| Published | Anyone, once every share is in | `publish(counts)` |
| Over | Each trustee | `reclaim()` |

`fail()` ends a poll that cannot finish: one still in setup at the close, or
one whose window has passed with shares missing.

## Why it holds up

- **No trustee can read a ballot alone.** It takes every trustee's secret.
  A trustee submits its key with a Schnorr proof that it knows the secret. Without
  that proof, the last trustee could submit `x·G − X₁ − …`, a key that cancels
  the others out, and the poll's key would be `x·G`, which it alone could read.
- **A ballot counts once, for one option.** The bit proofs stop a ballot from
  encrypting a 2, or a −1. The proof of one choice stops it from choosing two
  options or none. Each is needed: two votes for one option and minus one for
  another add up to one, and only the bit proofs refuse it.
- **A ballot cannot be copied.** Every proof's hash includes the voter's address
  and the poll's, so a ballot lifted from someone else's transaction is no
  ballot for the copier. Without that, a voter could copy another's ballot
  and vote the same way without knowing how, and so learn something from the
  result.
- **A voter votes once.** A ballot sets its voter's flag with an exclusive write,
  so two ballots from one voter in a block cannot both commit.
- **Ballots never conflict with one another.** Nothing a ballot writes is
  written by another voter's ballot, except the turnout, which merges, and the
  box, whose inserts commute. The proofs read only the poll's key. A box takes
  250 ballots a block. A ballot past that is left out of the block at commit,
  with nothing written, and its voter can send it to another station. Clients
  should pick a station at random.
- **Counting cannot be stalled.** Anyone can count, from the moment the poll
  opens, since a running total reveals nothing. Each station's count commits
  once a block, and takes everything waiting, up to 250 ballots. So taking a
  station's slot in a block does the same work as any other count would.
  Counts at different stations do not conflict, and they spread the work over
  the whole vote.
- **The result is checked.** Each share comes with a Chaum–Pedersen proof that it
  used the trustee's key's secret, and `publish` checks each count against the
  totals. Nobody, the trustees included, can publish counts the ballots do not
  add up to.
- **Withholding a share costs a bond.** A trustee could hold back its share to
  block a result it dislikes. The last trustee can work the result out before
  deciding. So each trustee deposits a bond with its key. If the window passes
  with a share missing, anyone can fail the poll. The trustees who decrypted
  reclaim their bonds, and the others' stay in the contract for good, so a
  failure profits nobody. The window starts when the count finishes, so no
  trustee is held to a deadline it could not meet.
- **The bonds cannot pay for storage.** On Thruput, a contract's storage is
  paid for out of its native tokens. Bonds held in native tokens would be the
  same money the poll's storage draws on, and an admin who registered voters
  after the bonds came in could spend them. So bonds are in a token the terms
  name, whose balances live in the token's storage. Trustees take them back with
  `reclaim`, and `publish` and `fail` move no tokens. So a token that refuses a
  transfer can hold up a bond, and not the result.
- **The admin has no say once the poll opens.** Opening freezes the roll and the
  key. The poll closes at a time fixed when it starts, and every later step is
  open to anyone, or to the trustees.
- **Voters cannot run up the poll's storage.** Each voter on the roll is an item
  of storage, paid for by the poll, and only the admin registers, before the
  poll opens. A ballot adds 8 base units, which the count gives back. The
  trustees' keys and shares are a few items each.
- **No step can be clogged.** Every loop is bounded: 4 options, 7 trustees, 8
  stations, a batch of 250. In the guest, the heaviest calls cost:

  | Call | Gas |
  | --- | ---: |
  | `cast`, 4 options | 1.38M |
  | `count`, 250 ballots | 34.4M |
  | `finish_count` | 2.07M |
  | `decrypt`, 4 options | 0.70M |
  | `publish`, 7 trustees | 1.07M |
  | `register`, 64 voters | 2.60M |

  The cap is 1,000M a transaction.

What it does not protect against:

- **Every trustee together can read every ballot.** Voters should check who the
  trustees are. A poll whose admin is its only trustee is a poll its admin can
  read.
- **A ballot is a receipt.** A voter who keeps its randomness can prove how it
  voted, so votes can be bought or coerced. Protecting against that takes
  re-encryption by a third party, or a different scheme.
- **A bond is a price, not a guarantee.** A trustee that values blocking the
  result above its bond can still block it. Choose a bond that matters to the
  trustees, and trustees with no stake in the outcome.
- **The roll is the admin's.** Who may vote is whatever the admin registers.
  Who voted is public; only how is secret.
- **Small counts say a lot.** If every ballot chose the same option, the result
  says how each voter voted. That is true of any secret ballot.
- **Ballots can be censored.** The block producer chooses what goes in a block.
- **The syscall is experimental.** `ristretto255_msm` may change.

## Storage and the float

Under the network's default prices, where an item costs 12,000 base units:

| What | Costs the poll |
| --- | ---: |
| A voter on the roll | 12,010, for good |
| A ballot, until it is counted | 8 |
| The first ballot in an empty box, until the box is empty again | 12,000 more |
| A ballot, while its block is open | 12,008 more, given back when the block closes |

The last line matters most. Until a block closes, each ballot's box entry is a
deposit of about an item, out of the poll's native tokens. So the poll's
*float*, what it holds beyond its storage, sets how many ballots a block can
take. A poll with a float of 60,140 takes five ballots a block. The rest are
left out at commit and land in later blocks: see
`the_polls_float_sets_how_many_ballots_a_block_takes`. For a vote that
may come in all at once, keep a float of 12,008 for each ballot a block should
take: up to 24M for the full 2,000.

## Use it

1. Deploy the poll, and call `initialize(paper, terms)` in the same transaction.
   The caller is the admin. Before or during that transaction, send the poll's
   address enough native tokens for its deployment, its storage, 12,010 for each
   voter, and the float.
2. Call `register(voters)`, 64 at a time.
3. Each trustee makes a key share `x`, keeps it, and grants the poll an allowance
   of the bond in `bond_token`. Then it calls `submit_key(x·G, proof)`.
4. Once every key is in, the admin calls `open()`. `state().key` is the poll's
   key.
5. Each voter encrypts its ballot to the poll's key, with the proofs, and calls
   `cast(station, ballot)` with a random station. If the ballot is left out of
   its block, the voter sends it again, to another station.
6. Anyone calls `count(station)` for the stations with ballots waiting. Once the
   poll has closed and every box is empty, anyone calls `finish_count()`.
7. Each trustee reads `totals()`, and calls `decrypt(shares)` within the window.
8. Anyone reads the shares, works out the counts, and calls `publish(counts)`.
   The trustees call `reclaim()`.

[`tests/prover/mod.rs`](tests/prover/mod.rs) does the voters' and trustees'
side with `curve25519-dalek`: making keys, ballots and shares, and finding the
counts. A wallet would do the same, with its own randomness.

## Read

1. [`group.rs`](src/group.rs): scalars, sums of points, and the transcript.
2. [`proofs.rs`](src/proofs.rs): the four proofs the contract checks.
3. [Implementation](src/implementation.rs): `cast` for the checks and the box,
   `count` for the batch, and `publish` for the final check.
4. [Prover](tests/prover/mod.rs): how a voter makes a ballot that proves one
   case and simulates the other.
5. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any of them commits, which is how a test puts them in
   one block.
6. [RV32 test](tests/test_rv32.rs): the largest poll, in the guest, with its
   gas.

## Try a change

In [`cast`](src/implementation.rs), delete the `is_bit` check, and rerun. Only
`a_ballot_must_choose_exactly_one_option` fails, at the ballot of 2, −1 and 0:
with the proof of one choice alone, a voter can vote twice for one option and
minus once for another.

In [`Transcript::new`](src/group.rs), and in the prover's, stop hashing `who`,
and rerun. Two tests fail. A copied ballot is accepted. So is a key copied
from the first trustee, with its proof, by the second: the poll's key is then
`2·X₁`, which the first trustee can read alone.
