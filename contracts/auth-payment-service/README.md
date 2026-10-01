# Explicit auth when only the inner service knows the payer

This example works through the composition question: an outer function calls a
service, which reads `from` from its own state and calls an ERC20 transfer. Must
the outer function know `from` or understand the downstream authorization?

Here it does neither. It **does** have an explicit authorization parameter.
The transaction builder still needs to obtain authorization from the right wallet.

## Read and run

Read these in order:

1. [`auth-payment-forwarder`](../auth-payment-forwarder/src/lib.rs): the outer
   function; the whole implementation is one forwarding call.
2. [`PaymentService::pay`](src/lib.rs): the inner function; only this contract
   reads the configured payer and interprets the outer capability.
3. [`auth-payment-wallet`](../auth-payment-wallet/src/lib.rs): verifies a signed
   payment request and mints a parent token containing an ERC20 debit token.
4. [`tests/payment.rs`](../auth-payment-wallet/tests/payment.rs): signs requests
   off-chain, executes the complete flow and checks balances and refusals.

From the repository root, with the usual Rust/registry setup:

```sh
cargo test -p auth-payment-wallet --locked
```

These tests use the native executor and real ed25519 signatures. They do not
preflight the payment to discover authorization requirements. They are not
live-node or RV32 execution tests. CI also builds the three guest contracts via
the existing `scripts/build-guest.sh` package discovery.

To build deployable artifacts individually:

```sh
groundhog build -p auth-payment-service
groundhog build -p auth-payment-forwarder
groundhog build -p auth-payment-wallet
```

## The application

Imagine a payment service whose administrator configures the funding wallet and
asset. A generic coordinator asks the service to pay a recipient. The wallet's
owner approves that payment; an unrelated relayer can submit it.

The application-facing methods are:

```rust,ignore
// Outer function: no payer, asset, signature, or decoded authorization payload.
PaymentForwarder::forward(service, to, amount, authorization: Signed<Opaque>);

// Inner function: no `from` argument; the payer comes from its stored configuration.
PaymentService::pay(to, amount, authorization: Signed<Opaque>);
```

The wallet is deliberately small: one fixed owner key, replay protection, and one
request type. It reuses `groundhog-signed-op`, as `permit-wallet` does. Deploy and
initialize the wallet and service atomically; their first initialization is open.
Key rotation and a production wallet UI are outside this example.

## Preparing a payment

The signer chooses the wallet, service, asset, recipient, amount, nonce and expiry.
The service exposes `get_payer` and `get_token` for clients that need to read its
configuration. Reading known configuration is distinct from executing a proposed
payment to discover its auth tree. The tests already know that configuration.

The signature covers a `PaymentRequest { service, token, to, amount }` plus the
existing SignedOp network, verifying-wallet, payload-type and uniquifier binding.
The relayer's transaction then explicitly performs two calls in one enclosing
frame:

1. Call the wallet's `execute_signed_op(request, signature)` to obtain a handle.
2. Pass that handle to `PaymentForwarder::forward(service, to, amount, handle)`.

The test's `submit` helper is the transaction composer. It knows which wallet to
call; the deployed forwarder does not. The signed request contains enough data
for this wallet implementation to construct the nested capabilities without
discovering any execution trace.

## What each capability authorizes

Both nodes are minted by the wallet. The runtime authenticates that minter and
enforces each node's consumer and single-use consumption.

| Node | Consumer | Payload | Checked by |
| --- | --- | --- | --- |
| Parent | Payment service | Recipient, exact amount, child debit token | Service: issuer equals its configured payer; recipient and amount equal the call |
| Child | Configured ERC20 | Service as spender, maximum amount | ERC20: consumer, caller/spender and amount bound |

The forwarder cannot consume the parent: its consumer is the service. The service
consumes the parent and receives the child handle. It then calls the existing
ERC20 `transfer_from_signed`, which consumes the child and debits its minter.
The service never mints a replacement token claiming to be the payer.

The child is the existing `PermitGrant`, so its recipient is chosen by its spender
and it can also be used to create an allowance. This service's code restricts its
use to the parent's exact recipient and amount and leaves no standing allowance.
The signer trusts that service implementation to enforce the outer request. This
is not a claim that the runtime independently enforces those business conditions,
or that an arbitrary upgraded service would obey them.

All payment calls propagate failures. If the service or ERC20 refuses, the
enclosing transaction rolls back the wallet nonce as well. A composer that catches
a payment failure and commits its earlier wallet call would have different nonce
behavior; the tests deliberately rethrow after checking a refusal's reason.

## What changes when the payer changes?

The test `only_the_inner_service_needs_to_know_that_the_payer_changed` switches the
service from Alice's wallet to Bob's. Configuration changes are observed after
advancing the block, following Groundhog's state model.

- The forwarder's deployed code and method signature stay the same.
- The forwarder still receives the same service, recipient and amount, plus one
  opaque handle. It never looks up either payer.
- An authentic Alice grant fails with `WrongPayer`.
- A grant from Bob succeeds and debits Bob instead.

The off-chain builder **must** obtain Bob's authorization. This example does not
make that identity discover itself, silently substitute a signer, or grant the
service authority merely because somebody called it. If configuration changes
after signing, the stale authorization fails.

Other tests cover recipient/amount tampering, replay, a different parent consumer,
a child grant for the wrong asset, no residual allowance, and nonce rollback.

## What this establishes in the Soroban comparison

Opaque forwarding lets an intermediary carry authorization without knowing the
payer, signature scheme, payload schema or child-token layout. Only the wallet and
service share `PaymentAuthorization`; changing the payer does not require an
intermediary rewrite. The public boundary still explicitly declares that it needs
one capability.

This does not demonstrate arbitrary changes to the number of independent
authorizers. The parent here has one minter and one child, and the wallet knows how
to build that structure. A new requirement for another account's approval still
needs a design for acquiring and transporting that account's authority. Likewise,
opaque payloads do not supply standard wallet rendering or policy semantics.

In Soroban, intermediate methods can omit the authorization parameter and the host
matches `require_auth` requests against separately supplied authorization trees.
This example makes the competing tradeoff concrete: explicit capability transport
can hide the payer and payload details, but it does not remove transport from the
method interface. It adds neither implicit auth lookup nor code-hash pinning.
