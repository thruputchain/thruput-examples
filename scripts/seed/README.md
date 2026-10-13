# Shared app seeding

This directory implements demo-data setup for Token Launchpad and Swap. It is
advanced app support code, not a small TypeScript SDK example. For the latter,
see [client examples](../../examples/typescript/README.md).

Run the public entrypoints from the repository root:

1. Follow [Launchpad setup and seeding](../../apps/token-launchpad/README.md#seeding).
2. Follow [Swap seeding](../../apps/swap/README.md#seeding) on the same node.

Launchpad seeding creates and indexes two tokens. Swap seeding uses those tokens
to create a pool and add liquidity. Set `SEED_RECIPIENT` before the first seed if
the assets should belong to your browser wallet rather than the tool account.

## Code map

- `seed.ts`: orchestrates token and pool setup through the published SDK.
- `seed-preflight.ts`: checks RPC access and the live factory/router relationship.
- `seed-scope.ts`: binds local state to the selected deployments and recipient.
- `seed-journal.ts`: preserves signed transaction evidence and handles resumption.
- `seed-liquidity.ts`: follows queued liquidity through its terminal event.

The tool writes `.local/seed/` and sends transactions. Reruns recover recorded
work rather than assuming an unknown transaction failed. Keep signer and journal
files until the outcome is resolved. See the Launchpad README for recovery
options; do not delete the state to bypass a scope mismatch.

Root `npm test` covers the unit tests here. `npm run test:seed` checks the live
flow and repeatability on an isolated node.
