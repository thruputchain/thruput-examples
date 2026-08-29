# Game of Life Explorer

Phase 5 read-only React application for exploring synchronized immutable generations of the 10,000 by 10,000 Groundhog Game of Life world.

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

The browser always uses same-origin `/groundhog-rpc` and `/groundhog-indexer` endpoints. Their loopback-only development proxies expose only the configured contract's read APIs. Phase 5 has no write methods, wallet, or credentials.

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

- Chain metadata, the latest pointer, immutable artifacts, and indexer status poll independently while the document is visible. Failures use bounded exponential backoff and visibility restoration refreshes every source.
- Chain, candidate preparation, renderer transition, and visualized snapshot are independent state. Status becomes stale at 15 seconds and affects health messaging only.
- The first eligible snapshot remains an epoch-bound candidate until its current viewport has digest-qualified GPU coverage and confirmed hidden and revealed frames. Missing, malformed, unavailable, or allocation-failed resources never gain visualization ownership.
- At most eight tile fetches and two decode workers run concurrently across both digest layers.
- Visible requests share seven slots and cancellable idle prefetch shares one; prefetched tiles are decoded into the shared digest-keyed CPU cache.
- A 32 MiB shared decoded cache and two 16 MiB deck tile caches cap aggregate CPU ownership at 64 MiB. Live app-owned GPU allocations have a separate 64 MiB budget.
- Density tiles are exact unsigned 16-bit little-endian counts. Exact tiles retain bit-packed LSB-first bytes for inspection and upload an integer cell texture.
- The browser requires immutable artifacts to match the configured world and either current chain metadata or valid retained event provenance. Metadata-observation provenance is current-only.
- The configured indexer verifies the complete snapshot against the on-chain digest. Individual tile bytes do not carry proofs.
- A temporary chain or indexer failure keeps the last verified snapshot visible. Regressions and same-generation digest conflicts never replace it.
- A newer digest is loaded in a separate layer. Level six requires digest-qualified GPU resources for every selected tile; density levels permit render-ready selected tiles or their immediate parents. The old layer remains opaque while the candidate fades over it with straight-alpha blending. Ownership changes only after coverage, a confirmed rendered frame, and current epoch/digest/chain approval; reduced motion switches without blending through the same gate.
- Phase 5 remains read-only. Requests, cranks, transactions, wallets, personas, and recovery belong to Phase 6.
