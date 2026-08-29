# Game of Life Explorer

Phase 4 read-only React application for exploring one immutable 10,000 by 10,000 Groundhog Game of Life generation.

## Requirements

- Node.js 22.12 or newer
- Chromium at `/usr/bin/chromium`, or set `CHROMIUM_PATH`
- A loopback Groundhog RPC endpoint and Phase 3 indexer

## Configuration

Set these public values before starting or building. Configuration is validated before React mounts.

```text
VITE_GROUNDHOG_RPC_URL=http://127.0.0.1:9545
VITE_GROUNDHOG_NETWORK_ID=<64 hexadecimal characters>
VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=<canonical lowercase 0x-prefixed 32-byte address>
VITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787
```

The indexer URL must be an origin root. Paths, queries, and fragments are rejected.

The browser always uses same-origin `/groundhog-rpc` and `/groundhog-indexer` endpoints. Their loopback-only development proxies expose only the configured contract's read APIs. Phase 4 has no write methods or credentials.

## Commands

```bash
npm ci
GROUNDHOG_CLI=/path/to/validated/groundhog npm run generate:contracts
npm run check:contracts
npm run typecheck
npm test
npm run test:chromium
npm run build
npm run verify
```

The generated contract binding is committed so a fresh checkout can build without the Groundhog CLI. Regeneration first builds `game-of-life`, then replaces the binding from `target/groundhog/game_of_life.spec.xdr`. `check:contracts` generates into a temporary directory and compares without modifying the committed file. It uses `GROUNDHOG_CLI` when set, otherwise `groundhog` from `PATH`. `verify` runs the contract check, typecheck, unit tests, and production build; Chromium remains a separate command. Build, Playwright, coverage, and local environment outputs are ignored.

## Boundaries

- At most eight tile fetches and two decode workers run concurrently.
- Visible requests reserve seven slots and cancellable idle prefetch reserves one; prefetched tiles are decoded into the normal CPU cache.
- Decoded CPU tile data and live app-owned GPU allocations each have independent 64 MiB budgets.
- Density tiles are exact unsigned 16-bit little-endian counts. Exact tiles retain bit-packed LSB-first bytes for inspection and upload an integer cell texture.
- The browser requires immutable artifacts to match the configured world and current chain metadata, but trusts the configured indexer for individual tile bytes; tiles have no individual cryptographic proofs.
- A temporary chain read failure keeps the last verified immutable snapshot visible and marks its chain metadata stale. Lower-generation or same-generation conflicting metadata is an integrity failure and blocks the visualization until a coherent current read succeeds.
- Phase 4 displays one immutable generation. Generation synchronization, transitions, product activity surfaces, transactions, wallets, and writes belong to Phases 5 and 6.
