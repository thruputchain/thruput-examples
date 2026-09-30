# SEP-41 Token

An example port (not for production) of [SEP-41] v0.5.2, the token interface
Stellar tokens share, to Groundhog. The port keeps SEP-41's balance, transfer
and burn functions, their argument names, order and types, their return
types, their events and their behaviour. It [leaves off](#left-off) the rest:
SEP-41's allowances, its `name`, `symbol` and `decimals`, its muxed
addresses, and its clawback event.

- [`sep41-token-if`](../../interfaces/sep41-token-if/): Interface-only crate.
  It defines SEP-41's `TokenInterface` trait and its generated `TokenClient`,
  SEP-41's transfer, burn and mint events, and the `TokenError` exceptions. A
  contract that calls a token depends on this crate only, as a Soroban
  contract uses `soroban_sdk::token`.
- `sep41-token`: A token implementing it, after the Soroban token example. It
  adds a `TokenAdmin` interface with the functions SEP-41 leaves to each
  token: `initialize`, and the administrator's `mint`.

The interface reads as SEP-41 does, less the `env: Env` parameter:

```rust
fn balance(&self, id: &ContractAddress) -> i128;
fn transfer(&mut self, from: &ContractAddress, to: &ContractAddress, amount: i128);
fn burn(&mut self, from: &ContractAddress, amount: i128);
```

## From Soroban to Groundhog

Where Groundhog has its own mechanism for something SEP-41 relies on, the
port uses it:

| SEP-41 on Soroban | SEP-41 on Groundhog |
| --- | --- |
| `env: Env` parameter | No parameter: the SDK reaches the host through free functions |
| `Address` | `ContractAddress`. Every Groundhog account is a contract, usually a wallet |
| `address.require_auth()` | `address` must be the caller. Groundhog authenticates the contract making a call, so an account authorizes a call by making it |
| Event name topic, `"transfer"` | Topic 0, the event's signature, which Groundhog derives from the event type's name and crate |
| Event data | The event's `amount` field: SEP-41's single-value data format |
| Panic or host error | A `TokenError` exception |
| Constructor | `initialize`, called in the transaction that deploys the token |

## Events

| Event | Topics after the signature | Data | Emitted by |
| --- | --- | --- | --- |
| `Transfer` | `from`, `to` | `amount: i128` | `transfer` |
| `Burn` | `from` | `amount: i128` | `burn` |
| `Mint` | `to` | `amount: i128` | `mint` |

An event's signature is derived from the crate that defines it, so the events
live in the interface crate: every token implementing it emits the same
signatures, and a wallet or indexer can recognize them. SEP-41 defines the
`Mint` event but not the function that emits it, so the token declares it on
`TokenAdmin`.

## Behaviour

The token follows SEP-41, and the Soroban token example where SEP-41 leaves a
choice:

- An amount is an `i128`, and a negative one throws `NegativeAmount`. An
  amount of 0 moves nothing, and still emits its event.
- A transfer or burn of more than `from`'s balance throws
  `InsufficientBalance`.
- A balance holds at most `i128::MAX`, and a mint or transfer that would take
  it higher throws `BalanceOverflow`.

## Left off

- **Allowances**: `allowance`, `approve`, `transfer_from` and `burn_from`, and
  the `approve` event. SEP-41's allowances are absolute: `approve` sets an
  allowance to an amount. That isn't compatible with values that change
  strictly relatively, as a Groundhog `Balance` does: it only increases and
  decreases, so that concurrent changes merge.
- **`name`, `symbol` and `decimals`**. The SEP-41 tokens on Groundhog wrap
  Stellar tokens, so a wallet can call the wrapped token's `name`, `symbol`
  and `decimals` on Stellar instead.
- **Muxed addresses**, which Groundhog has no counterpart for: `transfer`
  takes a plain `ContractAddress`, and the `transfer` and `mint` events carry
  no `to_muxed_id`.
- **Clawback**, and its event.
- **Authorization by anyone but the caller.** Soroban's `require_auth` also
  accepts an address that signed for a call deeper in the call tree. Here the
  address must make the call itself: a holder's wallet calls the token.

## Testing

Each scenario in `tests/common/mod.rs` runs against both builds of the token:

```sh
cargo test -p sep41-token      # natively
groundhog test -p sep41-token  # compiled to RV32, as on chain
```

[SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
