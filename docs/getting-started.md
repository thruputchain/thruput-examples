# Getting started

Run commands from the repository root unless a section says otherwise.

```sh
git clone git@github.com:thruputchain/thruput-examples.git
cd thruput-examples
```

Choose only the setup you need:

- **Native contract tests:** Rust and Cargo registry access.
- **Read-only client scripts:** Node.js, npm access, and a running local node.
- **Build or deploy a contract:** Rust, registry access, and the CLI.
- **Apps:** both toolchains; Launchpad and Swap also use Freighter for browser writes.

## 1. Rust and registry access

Install [rustup](https://rustup.rs/). The checked-in `rust-toolchain.toml` selects
the compiler, components, and RV32 target:

```sh
rustup show
```

The repository configures the `thruput` registry in `.cargo/config.toml`. You
need access to that registry. To save a token using Cargo's built-in provider:

```sh
CARGO_REGISTRIES_THRUPUT_CREDENTIAL_PROVIDER=cargo:token cargo login --registry thruput
export CARGO_REGISTRIES_THRUPUT_CREDENTIAL_PROVIDER=cargo:token
```

Enter the token at Cargo's prompt, not in a source file. For persistent provider
selection, set `credential-provider = "cargo:token"` under
`[registries.thruput]` in your user Cargo config. CI can instead supply
`CARGO_REGISTRIES_THRUPUT_TOKEN` with the same provider.

Now run the first example without a node:

```sh
cargo test -p counter --locked --test test
```

Expect two passing tests. Read the [Counter guide](../contracts/counter/README.md)
before moving to a browser app.

## 2. Install the CLI

This checkout uses CLI **0.29.0**, Rust SDK **0.51.0**, interface crates
**0.1.55**, and protocol crates **0.54.0**.

```sh
cargo install --locked --registry thruput --version 0.29.0 thruput-cli
thruput --version
```

If you have not created a local build profile, create `thruput.toml` at the
repository root with:

```toml
default_profile = "local"
[profile.local]
network = "local"
```

Keep any existing profiles you use. Build one contract:

```sh
thruput build -p counter
```

Look for `target/thruput/counter.rv32a` and `counter.spec.xdr`.
Use the CLI's matching runtime rather than an unrelated devnode build:

```sh
thruput toolchain install
thruput toolchain which
```

CLI 0.29.0 manages hog-devnode **0.1.31-rc.3**. Native Rust tests do not need it.

## 3. Install TypeScript dependencies

Use Node.js **22.13 or newer** and npm. From the root:

```sh
node --version
```

The published `@thruputchain/*` packages come from GitHub Packages. Configure a
PAT with `read:packages` and access to those packages in your user `~/.npmrc`:

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Set `GITHUB_PACKAGES_TOKEN` in your environment, then run:

```sh
npm ci
```

The root `.npmrc` selects the registry. Do not put the token in the repository.
This install covers all three apps and the small client examples. Run `npm ci`
after pulling lockfile changes to avoid stale SDK code.

## 4. Start a local node

In terminal A:

```sh
thruput node --port 9545 --json
```

Leave it running. Its JSON output includes an RPC URL and a runtime-manifest
path. In terminal B, set:

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_RPC_URL=http://127.0.0.1:9545
# Replace this with the path printed by terminal A:
export THRUPUT_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
```

The client scripts use a loopback HTTP endpoint and the localnet network ID.
App setup also reads the runtime manifest for network and storage configuration.
Use the new manifest after restarting the node. The localnet network ID alone
does not distinguish two local nodes.

Try a read-only request:

```sh
npm run example:chain-tip
```

Expect a network hash and block height. Continue with the
[client examples](../examples/typescript/README.md).

## 5. Try an app

For Counter, use the same terminal B environment:

```sh
npm run setup:local --workspace apps/counter
npm run dev --workspace apps/counter
```

Open `http://127.0.0.1:5175`. Setup builds and deploys a new counter and stores a
development signer in the app's ignored `.env.local`. Each setup run creates a
fresh deployment; restart the app server after setup.

Next: [Launchpad](../apps/token-launchpad/README.md#local-setup), then
[Swap](../apps/swap/README.md#local-setup). Follow
[Thruput Freighter](https://github.com/thruputchain/freighter) setup for browser
approvals. Configure it for the same node. Client-script tests do not establish
Freighter browser compatibility.

## Common setup problems

| Problem | Check |
| --- | --- |
| Cargo registry authentication fails | Registry access and the `cargo:token` provider |
| npm returns 401 or 404 for a private package | PAT package access, `read:packages`, and user npm auth configuration |
| RPC connection refused | Node is running; endpoint matches its printed URL |
| CLI/runtime manifest mismatch | Use the runtime installed by this CLI; a protocol override cannot repair a schema mismatch |
| Setup cannot read the manifest | Copy the current node's path into `THRUPUT_RUNTIME_MANIFEST` |
| Counter artifact is missing | Run `npm run examples:generate` before the deployment example |
| Old deployment stops matching the bindings | Rebuild and run fresh local setup; package installation does not upgrade deployed contracts |

For contributing and broader checks, see [Development checks](development.md).
