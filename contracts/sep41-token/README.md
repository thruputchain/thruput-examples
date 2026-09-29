# SEP-41 Token

An example port (not for production) of [SEP-41] v0.5.2, the token interface
Stellar tokens share, to Groundhog. The port keeps SEP-41's functions, their
argument names, order and types, their return types, its events and its
behaviour:

- [`sep41-token-if`](../../interfaces/sep41-token-if/): Interface-only crate.
  It defines SEP-41's `TokenInterface` trait and its generated `TokenClient`,
  the five SEP-41 events, and the types they use (`Address`, `MuxedAddress`,
  `String`, and the `TokenError` exceptions). A contract that calls a token
  depends on this crate only, as a Soroban contract uses `soroban_sdk::token`.
- `sep41-token`: A token implementing it, after the Soroban token example. It
  adds a `TokenAdmin` interface with the functions SEP-41 leaves to each
  token: `initialize`, and the administrator's `mint` and `clawback`.

The interface reads as SEP-41 does, less the `env: Env` parameter:

```rust
fn allowance(&self, from: &Address, spender: &Address) -> i128;
fn approve(&mut self, from: &Address, spender: &Address, amount: i128, live_until_ledger: u32);
fn balance(&self, id: &Address) -> i128;
fn transfer(&mut self, from: &Address, to: MuxedAddress, amount: i128);
fn transfer_from(&mut self, spender: &Address, from: &Address, to: &Address, amount: i128);
fn burn(&mut self, from: &Address, amount: i128);
fn burn_from(&mut self, spender: &Address, from: &Address, amount: i128);
fn decimals(&self) -> u32;
fn name(&self) -> String;
fn symbol(&self) -> String;
```

## From Soroban to Groundhog

Where Groundhog has its own mechanism for something SEP-41 relies on, the
port uses it:

| SEP-41 on Soroban | SEP-41 on Groundhog |
| --- | --- |
| `env: Env` parameter | No parameter: the SDK reaches the host through free functions |
| `Address` | `Address`, a `ContractAddress`. Every Groundhog account is a contract, usually a wallet |
| `MuxedAddress` | A `MuxedAddress` contract type: an `address` and an optional `id: u64`. An `Address` converts into one |
| `String` | `String`, a `heapless::String<100>`, so a contract needs no allocator. The contract spec carries it as a plain string |
| `address.require_auth()` | `address` must be the caller. Groundhog authenticates the contract making a call, so an account authorizes a call by making it |
| Ledger number | Block height |
| Event name topic, `"transfer"` | Topic 0, the event's signature, which Groundhog derives from the event type's name |
| Event data | The event's fields, which the contract spec names: SEP-41's map data format |
| Panic or host error | A `TokenError` exception |
| Constructor | `initialize`, called in the transaction that deploys the token |

## Events

| Event | Topics after the signature | Data | Emitted by |
| --- | --- | --- | --- |
| `Approve` | `from`, `spender` | `amount: i128`, `live_until_ledger: u32` | `approve` |
| `Transfer` | `from`, `to` | `amount: i128`, `to_muxed_id: Option<u64>` | `transfer`, `transfer_from` |
| `Burn` | `from` | `amount: i128` | `burn`, `burn_from` |
| `Mint` | `to` | `amount: i128`, `to_muxed_id: Option<u64>` | `mint` |
| `Clawback` | `from` | `amount: i128` | `clawback`, with no `Burn` or `Transfer` |

An event's signature is derived from the crate that defines it, so the events
live in the interface crate: every token implementing it emits the same
signatures, and a wallet or indexer can recognize them. SEP-41 defines the
`Mint` and `Clawback` events but not the functions that emit them, so the
token declares them on `TokenAdmin`. Where SEP-41's map format defines
`to_muxed_id`, it is `None` when there is no muxed ID.

## Behaviour

The token follows SEP-41, and the Soroban token example where SEP-41 leaves a
choice:

- An amount is an `i128`, and a negative one throws `NegativeAmount`. An
  amount of 0 moves nothing, and still emits its event.
- `approve` replaces the allowance rather than adding to it, and the allowance
  may exceed `from`'s balance: it is a spending limit, not a reservation.
- An allowance lasts through its `live_until_ledger` and is then 0.
  `approve` rejects a `live_until_ledger` before the current ledger, unless it
  is revoking the allowance by setting it to 0.
- `transfer_from` and `burn_from` reduce the allowance without changing when
  it expires, and fail if the allowance or `from`'s balance is short.
- A balance holds at most `i128::MAX`.

Groundhog runs every transaction in a block against the state the previous
block committed, and merges the block's storage changes when it commits. For
allowances this means:

- An approval can be spent from the next ledger on, or later in the
  transaction that makes it; another transaction in the same ledger sees the
  allowance the ledger began with.
- Spends in one ledger are each checked against the allowance the ledger
  began with, and together when it commits: a spend that would take the
  allowance below 0 is excluded from the ledger, to be retried in the next.
- `approve` sets the allowance, so it cannot commit in the same ledger as a
  spend of the allowance it replaces; the later of the two is excluded.

That is why an allowance's amount is an `NNInt`, which `approve` can set and a
spend decrements, rather than the `Balance` the balances use, which can only be
increased and decreased. The tests in `tests/common/mod.rs` spell out each of
these behaviours.

## Not carried over

- **Storage lifetimes.** Soroban storage expires unless its TTL is extended,
  and the Stellar Asset Contract caps `live_until_ledger` at the longest TTL.
  Groundhog storage does not expire, so there is no cap.
- **Authorization by anyone but the caller.** Soroban's `require_auth` also
  accepts an address that signed for a call deeper in the call tree. Here the
  address must make the call itself: a holder's wallet calls the token, or
  approves a contract, which then spends the allowance with `transfer_from`.
- **The Stellar Asset Contract's extras**, which SEP-41 leaves out: its fourth
  event topic, its `String` and `BytesN<32>` muxed IDs for classic memos, and
  functions such as `set_admin` and `set_authorized`.

## Testing

Each scenario in `tests/common/mod.rs` runs against both builds of the token:

```sh
cargo test -p sep41-token      # natively
groundhog test -p sep41-token  # compiled to RV32, as on chain
```

[SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
