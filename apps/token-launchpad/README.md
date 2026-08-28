# Groundhog Token Launchpad

Local-development application for creating standard tokens through the Groundhog standard-token factory.

## Supported stack

- Node.js 22.12 or newer
- npm
- Groundhog CLI 0.10.4
- `hog-devnode` 0.1.25-rc.1
- A disposable local node with at least three `local_user` accounts

## Install

The `@groundhogchain` packages come from GitHub Packages. On a machine without existing package access, create a GitHub token with `read:packages`, then configure npm without committing the token:

```bash
export GITHUB_PACKAGES_TOKEN=your_token
npm config set --location=user @groundhogchain:registry https://npm.pkg.github.com
npm config set --location=user //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"
npm --prefix apps/token-launchpad ci
```

Run the remaining commands from the repository root.

## Local setup

Start a disposable local Groundhog node whose runtime manifest includes the faucet and at least three local-user accounts. Then point the setup command at its runtime manifest:

```bash
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_CLI="$(command -v groundhog)"
npm --prefix apps/token-launchpad run setup:local
npm --prefix apps/token-launchpad run dev
```

`setup:local` builds and registers the standard-token artifact, deploys and initializes a zero-fee factory, verifies its immutable configuration, and writes `.env.local`. The generated file contains disposable local private keys, has mode `0600`, and is excluded from Git. The development server refuses to expose these credentials from a non-loopback host. Production builds and previews omit them.

The factory deployment and initialization use separate transactions because the pinned development wallet cannot batch a root deployment with a child call. This is safe only on a disposable isolated node. Production tooling must deploy and initialize the factory atomically.

The checked `.env.example` documents the public configuration fields but is not a usable configuration. Setup also writes `GROUNDHOG_DEV_PERSONAS`, which contains the three disposable private keys.

## Clean-ledger acceptance

The acceptance command starts an ephemeral node, provisions the launchpad, creates and verifies one token each for Alice and Bob, checks creator-filtered and global discovery, then restores any existing `.env.local`:

```bash
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm --prefix apps/token-launchpad run test:e2e:local
```

The command requires Linux with Bash, `flock`, and `setsid`, Groundhog CLI 0.10.4, and the pinned `hog-devnode` release. It must be run explicitly. The harness owns a disposable ledger, temporarily replaces and restores `.env.local`, and uses the repository's ignored build output.
