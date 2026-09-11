# Launchpad and Swap operations

Start with [wallet app development](wallet-local-development.md) for installation,
setup, and the two dev servers. Both servers now include their own registry API.

## Launch handoff

Set Launchpad's `VITE_SWAP_APP_URL` to the Swap root origin. A verified launch
offers **Create AMM Pool**, passing only the actual token address as `tokenA`.
It does not transfer wallet permissions, amounts, or approval. Swap reads live
metadata and still requires review. Existing recovery takes priority over URL
presets. A two-token link may supply both `tokenA` and `tokenB`.

## Indexed token suggestions

Set these in Swap's environment, using Launchpad's factory and code hash:

```dotenv
VITE_TOKEN_DISCOVERY_ENABLED=true
TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:5173
VITE_STANDARD_TOKEN_FACTORY_ADDRESS=0x...
VITE_STANDARD_TOKEN_HASH=0x...
```

The fixed server-side proxy reads Launchpad's status and token endpoints. It
checks network/factory identity, bounds responses, and never accepts an upstream
URL from the browser. Manual token entry remains usable during discovery outages.

Both app directories use their registry API. Mutable balances and reserves are
read from the chain. SQLite is an index of canonical creation events, not a
replacement for chain state. Seeding also uses these APIs, not direct inserts.

## Deployment

Use the full npm workspace and built sibling SDK in the build context. Run each
app's `build` and `start` commands. Set `PORT` and its database path on a persistent
volume. Run one process per database; use consistent WAL-aware backups.

Public settings must match at build and runtime. Deploy the immutable artifact
`contract-artifacts/<hash>.json` matching `VITE_STANDARD_TOKEN_HASH` for Launchpad
or `VITE_POOL_TOKEN_HASH` for Swap. Build/startup verify the schema and computed
hash; neither repairs missing assets. Rebuild after public configuration changes.

Registry mode is always enabled. The old `VITE_TOKEN_REGISTRY_ENABLED` and
`VITE_POOL_REGISTRY_ENABLED` environment toggles are no longer needed. App RPC
proxies remain read-only; connected wallets submit directly to their configured
RPC. `/healthz` checks the database, while `/api/registry/status` reports freshness
and any limited retained history.

Use a new database for another network/factory scope. Do not edit stored scope
metadata. Optional explorer and Swap URLs accept root HTTPS origins or exact
loopback HTTP origins. Configure every integration for the same network.

See [demo seeding](demo-seeding.md) for the repeatable seeded environment and
[wallet acceptance](wallet-acceptance.md) for isolated full-journey tests.
