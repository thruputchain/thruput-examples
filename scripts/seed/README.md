# Fresh local demo assets

Set up Launchpad first. For a pool, also set up Swap on the same local node.
App servers do not need to be running. From the repository root:

```sh
export SEED_RECIPIENT=0x<your-public-wallet-address>
npm run seed --workspace apps/token-launchpad
# Or create a separate token pair and pool in one run:
npm run seed --workspace apps/swap
```

- Launchpad: two new tokens, 1,000,000 units each, delivered to the recipient.
- Swap: two new tokens, a new pool with 1,000 units of each, and LP tokens plus
  the remaining 999,000 units of each delivered to the recipient.
- Both: recipient is token administrator; tokens have six decimals.

Every invocation creates new assets with a fresh in-memory signer. There is no
saved key, journal, lock, or resume mode. Only loopback HTTP localnet is accepted.
Configuration and artifact checks happen before funding or deployment.

The tool prints each transaction hash before submission and confirms completed
steps. An error stops the run without retrying writes. Partial assets may remain
and balances held by the discarded signer cannot be recovered. Inspect the
printed hashes; start a fresh node if you want to discard a partial demo.

Path overrides: `LAUNCHPAD_APP_ENV`, `LAUNCHPAD_APP_PUBLIC_DIR`, `SWAP_APP_ENV`,
`SWAP_APP_PUBLIC_DIR`. Paths resolve from the repo root. `THRUPUT_RPC_URL`
overrides the local endpoint. Configure Freighter for the same node to use the
assets. Existing recovery files from older runs are not read or deleted.

`npm test` checks failure boundaries. `npm run test:seed` checks the real flow
and verifies that reruns create distinct assets. For smaller SDK examples, see
[examples/typescript](../../examples/typescript/README.md).
