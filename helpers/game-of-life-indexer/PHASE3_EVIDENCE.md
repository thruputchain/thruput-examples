# Phase 3 Live Indexer Evidence

Date: 2026-08-29

The live acceptance workflow ran against a fresh ephemeral node using protocol `hogp/81e1cb073cfb`, RPC/signing packages `0.10.4`, and an initialized 100-million-cell contract.

## Results

- Generation-zero initialization committed at height 6 in 2.01 seconds.
- The indexer downloaded, verified, published, served, and restart-checked generation zero in 2.64 seconds.
- One request and full atomic crank advanced the complete world; the crank itself took 7.03 seconds.
- The indexer downloaded, verified, published, served, and restart-checked generation one in 2.69 seconds.
- `latest.json`, manifests, provenance, representative tiles, SQLite evidence, event cursor, predecessor retention, and byte-identical restart inventory all passed.
- Two retained generations occupied 167,513,163 apparent artifact bytes. The closed SQLite database occupied 36,864 bytes.

## Command

With the node, runtime manifest, initialized contract, and high-gas crank variables configured:

```bash
helpers/game-of-life-indexer/scripts/live-acceptance.sh
```

The script runs the ignored generation-zero acceptance test, `advances_complete_world_once`, and the generation-one acceptance test in order. It uses a temporary work directory unless `GAME_OF_LIFE_LIVE_WORKDIR` is set.
