# Groundhog Token Launchpad

Local-development application for creating standard tokens through the Groundhog standard-token factory.

## Local setup

Start a disposable local Groundhog node whose runtime manifest includes the faucet and at least three local-user accounts. Then point the setup command at its runtime manifest:

```bash
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_CLI="$(command -v groundhog)"
npm run setup:local
npm run dev
```

`setup:local` builds and registers the standard-token artifact, deploys and initializes a zero-fee factory, verifies its immutable configuration, and writes `.env.local`. The generated file contains disposable local private keys, has mode `0600`, and is excluded from Git. The development server refuses to expose these credentials from a non-loopback host. Production builds and previews omit them.

The factory deployment and initialization use separate transactions because the pinned development wallet cannot batch a root deployment with a child call. This is safe only on a disposable isolated node. Production tooling must deploy and initialize the factory atomically.

The checked `.env.example` documents the generated keys but is not a usable configuration.

## Clean-ledger acceptance

The acceptance command starts an ephemeral node, provisions the launchpad, creates and verifies one token each for Alice and Bob, checks creator-filtered discovery, then restores any existing `.env.local`:

```bash
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm run test:e2e:local
```

The command requires Groundhog CLI 0.10.4 and the pinned `hog-devnode` release. It must be run explicitly. The harness owns a disposable ledger, temporarily replaces and restores `.env.local`, and uses the repository's ignored build output.
