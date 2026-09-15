# Wallet download service

A small Node.js service for the dedicated **Wallet** service in Railway's **Demo Apps** project. Its canonical source is `groundhogchain/groundhog-examples`, alongside the other hosted apps. It serves a prebuilt extension ZIP and installation instructions, with no RPC dependency, signing keys, database, or persistent volume.

## Build and run

From the repository root, with npm package authentication configured:

```sh
npm ci
npm run build --workspace apps/wallet-download
npm run start --workspace apps/wallet-download
```

Open `http://localhost:3000`. The build installs and builds the separate wallet-extension package, checks its Devnet permissions, and packages its dist files into a versioned ZIP. The build hash is part of the filename. Archive timestamps are fixed so unchanged inputs produce the same ZIP.

Routes:

- `/` — download page and installation steps
- `/wallet.zip` — download the current ZIP
- `/<versioned-filename>.zip` — download that build
- `/SHA256SUMS` — checksum and versioned filename
- `/release.json` — version, hash, filename, and size
- `/healthz` — returns 200 after the archive passes its startup checksum check

## Railway settings

Create a **Wallet** service connected to **`groundhogchain/groundhog-examples`** in **Demo Apps**. Use the repository root, not an app subdirectory or the hackathon repository.

| Setting | Value |
| --- | --- |
| Builder | Railpack; root `railpack.json` selects Node 22 |
| Build command | `npm run build --workspace apps/wallet-download` |
| Start command | `npm run start --workspace apps/wallet-download` |
| Variable | `PORT=3000` |
| Healthcheck | `/healthz` |
| Watch paths | `/apps/wallet-extension/**`, `/apps/wallet-download/**`, `/package.json`, `/package-lock.json`, `/railpack.json`, `/.npmrc` |

Use the same private npm authentication setup as the existing app services. It must work for both the root install and the wallet-extension install during the build. No `VITE_*` variables are needed.

Generate a public domain, verify `/healthz`, and download and check the ZIP. Add the service URL to `WALLET_SETUP.md` and `ADDRESSES.md` in `groundhogchain/hackathon`. That repository contains participant guides and example source copies; hosted services build from this canonical repository.
