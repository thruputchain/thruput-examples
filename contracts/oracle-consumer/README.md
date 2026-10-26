# Oracle consumer: read a price from another contract

Read a price through a generated Rust client, check its source timestamp, and
value an integer token quantity. The oracle stores prices already published on
Thruput. This contract makes no HTTP requests to Stellar or Chainlink.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli). From the repo root:

```sh
cargo test -p oracle-consumer --locked --test test
```

Expected: **13 tests pass**, including the SDK's storage-domain check. The tests
register the consumer and a test-only oracle, so no node, keys, relay worker,
or network access is needed after dependencies and the test executor are installed.

With the CLI installed, build and test the guest consumer:

```sh
thruput build -p oracle-consumer
thruput test -p oracle-consumer
```

The artifact is `target/thruput/oracle_consumer.rv32a`. The guest test runs this
artifact against the native oracle fixture; it does not test a live relay.

## Read

1. [Contract](src/implementation.rs): `latest_price` makes the cross-contract
   call and checks the observation. `value` uses that checked price.
2. [Read interface](src/oracle.rs): `#[contract]` generates `OracleClient` from
   the relay's method signature and return types.
3. [Tests](tests/test.rs): price reads, freshness boundaries, errors, precision,
   rounding, and overflow. The [fixture](tests/common/mod.rs) accepts invalid
   prices for testing and must not be used as a real oracle.

The cross-contract call is:

```rust
let observation = OracleClient::new(oracle).get_price(feed_id).observation;
```

`latest_price(oracle, feed_id, max_age_seconds)` returns the price, feed ID,
decimals, source timestamp, and round. It rejects non-positive prices, zero
timestamps or rounds, a different feed ID, precision above 18, future source
timestamps, and observations older than the caller's limit. The age limit is
inclusive. Publication time (`accepted_at`) does not make an old price fresh.
Oracle exceptions and failed calls propagate; there is no fallback price.

## Value a token quantity

`value(oracle, feed_id, amount, amount_decimals, max_age_seconds)` calculates:

```text
floor(amount × price / 10^amount_decimals)
```

For example, `amount = 15` with `amount_decimals = 1` means 1.5 tokens.
At `price = 30_000_000_001` with six price decimals, the result is
`45_000_000_001`: 45,000.000001 quote units, rounded down.

Token decimals describe the amount. Feed decimals describe the price and the
returned value. The calculation uses a 256-bit intermediate and rejects a final
result outside `u128`. USD-quoted feeds return USD values; other feeds return
their own quote currency.

## Use a published oracle

The read interface follows the
[Stellar → Thruput oracle relay](https://github.com/thruputchain/thruput-stellar-oracle-relay)
at revision [`286c485`](https://github.com/thruputchain/thruput-stellar-oracle-relay/tree/286c485).
It preserves the `Contract` interface name, version `0.1.0`, `get_price(u32)`
signature, and `PriceRecord` field layout. The ABI test checks the read against
entrypoint `0x8c8947ffd495b451` from that revision's generated binding. Changing
the interface name would select a different entrypoint.

For a live setup:

1. Follow the relay README to select feeds, deploy an oracle, and start its worker.
2. Deploy this consumer on the same Thruput network.
3. Call `latest_price` or `value` with that oracle address, its registered feed ID,
   and your application's maximum age in seconds.

The relay revision uses SDK 0.51.1 and CLI 0.30.0; this example uses the workspace's
SDK 0.57.0 and CLI 0.39.0. The local tests check the read ABI, not live runtime
compatibility. A live deployment needs relay artifacts and tooling compatible
with the chosen network; do not assume the older build can run on a newer node.

Choose a trusted oracle and verify which asset and quote currency its feed
represents. The relay trusts its publisher; it does not verify Stellar consensus
inside the oracle contract. A feed ID is not a token address. Applications can
map each token address to an oracle address and feed ID.

This stateless example lets callers choose the oracle and age limit. A lending
or payment contract must enforce its own trusted configuration before using a
price to move funds.

## Try a change

Change the fixture's source timestamp from `now - 100` to `now - 101`. Run the
tests and check why a 100-second age limit now rejects the observation, even
though `accepted_at` is still `now`.

Next: [Cross-call](../cross-call/README.md) for more call and error patterns.
