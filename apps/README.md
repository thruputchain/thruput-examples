# Apps

Five teaching apps. Each one shows a Thruput pattern in a small React app with
a small Node.js server. They are not production services: each README lists
what the app leaves out on purpose.

| App                                          | What it shows                                              | Local URL             |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------- |
| [Counter](counter/README.md)                 | Many concurrent transactions, signed by a development key  | http://127.0.0.1:5175 |
| [Voting](voting/README.md)                   | Wallet transactions, reads, and recovery after a reload    | http://127.0.0.1:5176 |
| [Airdrop](airdrop/README.md)                 | A one-time claim per wallet                                | http://127.0.0.1:5177 |
| [Token Launchpad](token-launchpad/README.md) | Factory-created tokens and a small event indexer           | http://127.0.0.1:5173 |
| [Swap](swap/README.md)                       | Queued requests, cranking, and liquidity                   | http://127.0.0.1:5174 |

Start with Voting. It is the smallest wallet app, and the other wallet apps use
its transaction pattern.

## Run all five apps locally

Complete the root [Setup](../README.md#setup). Start
`thruput node --port 9545 --json` in one terminal. In another terminal, from the
repository root:

```sh
npm run setup:local
npm run dev
```

`setup:local` builds and deploys fresh contracts for Counter, Launchpad, Swap,
and Voting, then deploys Airdrop with seven demo tokens and six seeded pools. It
writes each app's ignored `.env.local`. `dev` starts all five apps with those
deployments. Ctrl+C stops the apps; stop the node separately. These commands
use POSIX process groups (Linux and macOS).

Counter needs no wallet. For the other apps, install
[Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/),
select the same local RPC endpoint, and request test tokens in the wallet.

A local node loses its contracts when it stops. After you restart it, run
`setup:local` again. Airdrop setup does not replace an existing distribution:
keep the old Airdrop environment and set a new `AIRDROP_ENV_PATH`. See the
[Airdrop README](airdrop/README.md).

To run one app:

```sh
npm run setup:local --workspace apps/<app>
npm run dev --workspace apps/<app>
```

Local development needs no Railway account or devnet connection. Leave
`APP_BASE_PATH` unset locally.

## Hosted examples

<https://examples.thruput.network/> serves all five apps under one domain on
devnet. The [gateway guide](gateway/README.md) describes the deployment.

## Visual identity

The apps use the Stellar Thruput identity and follow the system's light or dark
theme. Each app keeps its tokens in `src/styles.css`.

- Inter Variable is used for headings, body text, and actions. Inconsolata
  Variable is used for code, numbers, balances, and system labels. Both are
  self-hosted through Fontsource.
- The `signal` token stays yellow (`#FDDA24`) for filled actions. `primary` is a
  theme-aware accent for links and focus indicators. Keep these roles separate.
- The SVGs in each app's `public/brand/` and its favicon use the official
  Stellar Logo Press Kit 2026 vector paths.
