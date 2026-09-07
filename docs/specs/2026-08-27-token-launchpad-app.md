# Groundhog Token Launchpad App Specification

**Status:** Reviewed implementation specification
**Date:** 2026-08-27
**App path:** `apps/token-launchpad`

## 1. Summary

Build a local-development web app that lets a user create a standard ERC-20 token through the standard token factory. The user enters token metadata and an initial supply, reviews the deterministic address and required HOG, then launches through one automatic flow. An optional manual mode exposes each transaction separately.

The launchpad is a sibling of `apps/swap`. It uses the same Vite, React, TypeScript, Tailwind CSS, shadcn/ui, Groundhog client, local RPC proxy, and disposable development-wallet architecture. Its visual design should read as another Groundhog demo rather than a separate product.

This is example software for a local Groundhog node. It is not production wallet or deployment tooling.

## 2. Goals

- Let Alice, Bob, or Carol create a standard token without using the CLI.
- Collect and validate name, symbol, decimals, and initial supply.
- Default token administrator and initial holder to the active development wallet.
- Predict and display the token address before any transaction is signed.
- Explain and execute predicted-address HOG funding.
- Require the configured local factory to have no creation fee.
- Persist enough workflow state to recover after refresh, tab closure, or an indeterminate submission.
- Verify the returned address, `TokenCreated` event, metadata, total supply, and initial-holder balance.
- Show all discoverable tokens created by the current factory and a creator-filtered view for the active wallet.
- Reuse the swap app's three-persona wallet switcher and visual language.

## 3. Non-Goals

- Production key custody, browser-extension wallets, hardware wallets, or arbitrary account import.
- Deploying arbitrary token implementations.
- Uploading token images or storing off-chain metadata.
- Changing token metadata after creation.
- Managing minting, burning, transfers, or allowances after launch.
- Deploying or initializing a production factory.
- Guaranteeing atomic HOG funding and token creation with the pinned DevWallet.
- A registry spanning multiple networks or factories.

## 4. Users and Personas

The app uses the same three predefined local users as the swap demo:

| Persona | Role in the demo |
|---|---|
| Alice | Default creator and first launchpad user |
| Bob | Independent creator used to demonstrate creator-scoped prediction |
| Carol | Independent creator used to demonstrate a third creator namespace |

Each persona is a local public-key signer backed by a disposable private key injected only by the loopback Vite development server. The selected persona is stored in `sessionStorage`, scoped by network and factory. Switching personas remounts transaction-bound UI and never exposes private keys through React context.

Production builds and Vite preview must not contain development private keys.

## 5. Product Experience

### 5.1 Application shell

The shell follows `apps/swap`:

- Warm off-white dotted background, dark green primary color, Geist typography, and the same radius scale.
- Header brand: **Groundhog Launchpad**.
- Navigation: **Tokens**, **My Tokens**, and **Create Token**.
- The same shadcn wallet switcher appears at the right of the header.
- Main content uses the same `max-w-5xl`, mobile padding, and heading treatment as the AMM demo.
- Layouts support 320 px mobile through desktop widths.

### 5.2 Create page

Route: `/create` and default route `/`.

The desktop layout has a token form and live review panel. It collapses to one column on mobile.

Form fields:

| Field | Input | Validation | Default |
|---|---|---|---|
| Symbol | Text | 1-10 UTF-8 bytes after trimming | Empty |
| Token name | Text | 1-100 UTF-8 bytes after trimming | Empty |
| Decimals | Number | Integer, 0-18 for this UI | 7 |
| Initial supply | Decimal text | Non-negative, precision no greater than decimals, base units no greater than `i128::MAX` | `1000000` |

The contract accepts absent metadata and decimals through its ABI, but this launchpad requires all three metadata fields so every created token has a useful display identity.

Advanced details are read-only in v1:

- Administrator: active wallet.
- Initial holder: active wallet.
- Application nonce: cryptographically random 32 bytes, generated once per workflow.
- Factory implementation hash and native-token address.

The live review panel shows:

- Token monogram and symbol.
- Formatted initial supply.
- Predicted token address after a successful review read.
- Factory creation fee.
- Required HOG reserve and estimated transfer amount.
- Administrator and initial holder as the active persona.

Only **Launch token** and the current manual creation step use the filled primary button style. Secondary actions use outline or ghost variants.

### 5.3 Creation progress

After review, the primary action runs or resumes these steps:

1. Fund predicted token address.
2. Create and initialize token.
3. Verify the committed token.

The UI shows each step as pending, active, complete, failed, or uncertain. It displays the transaction hash when available. Automatic processing is the default and submits funding followed by create-and-initialize as one user flow. The **Manual transaction processing** switch exposes one control per transaction, such as **Fund token address** or **Create token**. Recovery confirmations remain separate actions in either mode.

An indeterminate transaction pauses the workflow. The app observes a stored hash before allowing another submission. The local write boundary must persist `onSigned` synchronously before submission; if persistence fails, it aborts submission. A `signing` step without a hash is therefore recoverable as not submitted only after the stored workflow and boundary invariant are validated.

### 5.4 Success state

After verification, show:

- Token name and symbol.
- Token contract address with copy action.
- Initial supply and holder balance.
- Administrator.
- Creation transaction hash and block height.
- **Create another token** secondary action.
- **View my tokens** navigation action.

### 5.5 Token directories

Routes: `/tokens` and `/my-tokens`.

The global `/tokens` directory queries `TokenCreated` events for the configured factory. `/my-tokens` applies the active-wallet creator topic. When the persistent registry specified in [Token Launchpad Persistent Registry](./2026-09-05-token-launchpad-persistent-registry.md) is enabled, these pages query its paginated chain-derived index instead of rescanning event history in each browser. Each item shows:

- Symbol, name, and decimals from current token views in direct-chain mode or the canonical creation event in registry mode.
- Token address.
- Initial supply from the event.
- Current active-wallet balance.
- Administrator.
- Creation block height.

Use shadcn `Empty`, `Skeleton`, `Alert`, `Badge`, and `Button` components for empty, loading, partial-failure, and refresh states. Direct-chain mode fetches at most the latest 100 events, requests one extra record or inspects the page cursor to detect truncation, and labels the result as incomplete when more history exists. Registry mode provides bounded pages, live active-wallet balance enrichment, and an incomplete-history warning when the indexer reports a retention gap.

### 5.6 Wallet popover

Reuse the swap demo's interaction and component structure:

- Alice, Bob, and Carol selector.
- Active-wallet checkmark and shortened address.
- Portfolio section below a separator.
- HOG balance plus positive active-wallet balances from factory-created tokens known through `TokenCreated` events.
- Manual refresh and partial-failure feedback.

## 6. Factory and Token Semantics

### 6.1 Trusted configuration

Environment configuration provides:

- RPC URL.
- Network hash.
- active wallet address.
- wallet entrypoint.
- standard token factory address.
- native HOG address.
- native balance-item cost for the pinned local runtime.
- expected standard-token implementation hash.

On load, the app reads `StandardTokenFactory.config()` and verifies:

- The configured native token equals the expected HOG address.
- The configured token hash equals the expected release hash.
- `required_token_funding` is positive and within the signed amount bound.
- `creation_fee` is zero and `fee_recipient` is absent.
- The environment's native balance-item cost matches the runtime manifest used by local setup.

The app must stop state-changing actions if these checks fail.

### 6.2 Prediction

The app generates a nonce with `crypto.getRandomValues(new Uint8Array(32))` and persists it before signing. It calls `predictToken` with:

- Factory: configured factory.
- Creator: active DevWallet contract address.
- Nonce: persisted application nonce.

The same DevWallet must invoke `createToken`; otherwise the actual child address differs.

### 6.3 Funding

The factory requires a free native-HOG reserve at the predicted address. For a confirmed-empty address in the pinned local runtime:

```text
funding transfer = required_token_funding + native balance-item cost
```

Before every action, the app reads the predicted address's current free HOG balance through the native token interface. Funding is computed from observed state:

- If free HOG already meets `required_token_funding`, send nothing.
- For a new workflow with zero free HOG and no prior accepted funding transaction, transfer `required_token_funding + native balance-item cost`.
- If a balance item is known to exist through a prior committed funding receipt or a positive observed balance, transfer only the reserve deficit.
- If a funding transaction is uncertain, observe its stored hash before calculating or submitting another transfer.

Persist the pre-transfer balance and verify committed funding by re-reading free HOG. Excess HOG remains at the token for future storage and cannot be withdrawn through v1.

### 6.4 Creation arguments

The app invokes `StandardTokenFactory.createToken` with:

```ts
{
  nonce,
  administrator: activeWallet,
  name,
  symbol,
  decimals: BigInt(decimals),
  initialHolder: activeWallet,
  initialSupply,
}
```

The factory validates nonzero administrator and holder addresses and requires `initialSupply <= i128::MAX`.

### 6.5 Verification

After a committed success, require all of the following:

- Decoded return address equals the prediction.
- Exactly one factory-scoped `TokenCreated` event matches the token and creator.
- Event metadata, implementation hash, administrator, holder, and supply match the workflow.
- The initial mint event matches the submitted supply when supply is nonzero and is absent when supply is zero.

The receipt return, matching `TokenCreated`, and initial mint event are authoritative creation evidence. Metadata, total-supply, and holder-balance views are immediate consistency checks because those values can change after creation. Retry temporary read failures and show a warning rather than misclassifying an evidenced creation as failed. The app keeps the nonce and transaction evidence.

## 7. Transaction Safety and Recovery

Creation is a persisted state machine scoped by network, factory, and creator wallet.

Persisted data includes:

- Version and workflow ID.
- Creator, factory, nonce, and predicted address.
- Normalized form values and base-unit supply.
- Reviewed factory config and funding calculation.
- Per-step status and transaction hash.
- Final token address and verification result.

Each signing step follows this order:

1. Persist `signing` before requesting a signature.
2. Persist the canonical transaction hash synchronously through `onSigned`.
3. Submit and observe.
4. Persist the authoritative result.

Use an account-scoped Web Lock to serialize launchpad writes across tabs and persona changes. Every action acquires the lock, reloads and validates the persisted workflow ID and version, re-reads chain state and immutable factory config, and only then chooses and signs the next step. React state is never authoritative inside the lock. If Web Locks are unavailable, disable state-changing actions rather than risk duplicate submissions.

Storage and lock namespaces use `groundhog-token-launchpad:*` and must not collide with the swap app.

Persisted data is security-sensitive workflow evidence. Parse or write failure disables signing. The UI may clear only workflows with no signed unresolved hash; unresolved evidence must remain inspectable. The pinned DevWallet accepts one child invocation, so funding and creation are separate transactions. A failed creation does not roll back previously committed funding. The same nonce and predicted address remain recoverable.

## 8. Local Setup

`npm run setup:local` follows the swap setup pattern:

1. Require a running local node and runtime manifest with faucet plus Alice, Bob, and Carol.
2. Load the three local users and derive their disposable browser keys from the manifest seed.
3. Build or load the standard-token and factory RV32 artifacts.
4. Register the standard-token artifact with the runtime.
5. Deploy, fund, and initialize a zero-fee standard-token factory; its configuration is immutable thereafter.
6. Verify factory config views.
7. Write `.env.local` atomically with mode `0600`.

The current DevWallet cannot atomically deploy and initialize the factory. The local setup therefore performs those operations in separate transactions on an isolated node. This leaves a permissionless initialization race and is acceptable only for this disposable demo. Production release tooling must deploy and initialize the factory atomically.

## 9. Technical Architecture

### 9.1 Stack

Match `apps/swap` versions and conventions:

- React 19 and React Router 7.
- Vite 7.
- TypeScript 6 with strict mode and `exactOptionalPropertyTypes`.
- Tailwind CSS 4.
- shadcn/ui `radix-nova` with CSS variables and Lucide icons.
- Vitest, jsdom, and Testing Library.
- `@groundhogchain/client` 0.4.0 and protocol packages 0.8.0.

### 9.2 Suggested source layout

```text
apps/token-launchpad/
  scripts/
    generate-contract-bindings.sh
    setup-local.sh
    setup-local.ts
  specs/
  src/
    components/
      development-wallet-switcher.tsx
      launchpad-page.tsx
      wallet-portfolio.tsx
      ui/
    contracts/
      generated/
      factory-adapter.ts
      token-adapter.ts
      targets.ts
    groundhog/
      client.ts
    launch/
      create-page.tsx
      form.ts
      review.ts
      workflow.ts
      executor.ts
      verification.ts
    tokens/
      token-list-page.tsx
      token-reader.ts
    transactions/
      local-development-wallet.ts
      outstanding-request.ts
      outcome.ts
      write-boundary.ts
    wallet/
      portfolio.ts
    app.tsx
    config.ts
    development-personas.ts
    main.tsx
    styles.css
```

Generated bindings are never edited manually. Handwritten adapters isolate generated names and codecs from application services.

### 9.3 RPC proxy

Copy the swap app's defensive local proxy and allow only methods used by this app:

- `groundhog_chainTip`
- `groundhog_getEvents`
- `groundhog_getTransactionReceipt`
- `groundhog_getTransactionStatus`
- `groundhog_sendRawTransaction`
- `groundhog_view`

Reject batches, oversized requests, cross-origin requests, credentials in RPC URLs, and non-loopback proxy targets.

## 10. UI and Accessibility Requirements

- Use shadcn components for all buttons, fields, cards, alerts, badges, popovers, separators, loading placeholders, and empty states.
- Forms use `FieldGroup`, `Field`, `FieldLabel`, `FieldDescription`, and `FieldError`.
- Every input has `id`, `name`, associated label, autocomplete guidance, and `aria-invalid` when invalid.
- Validation errors are field-specific and summarized in an alert after submit.
- Progress updates use `aria-live`; errors use `role="alert"` through shadcn Alert semantics.
- Buttons preserve at least 48 px touch targets on mobile and use at most two visual sizes.
- Header navigation wraps cleanly on narrow screens, matching the swap app.
- Identifiers use monospace, truncation or wrapping, tooltips, and copy buttons.
- Do not rely on color alone for progress or error meaning.
- Honor `prefers-reduced-motion`.

## 11. Error Messages

Use specific user-facing errors:

- **Factory unavailable:** The configured token factory could not be verified.
- **Insufficient HOG:** This wallet needs at least `{amount}` more HOG for token funding. Execution costs may require additional HOG.
- **Funding failed:** The token address was not funded. No token was created.
- **Creation failed:** The factory did not create the token. Funding remains at the predicted address.
- **Transaction uncertain:** The transaction may still commit. Keep this workflow and check again before retrying.
- **Verification incomplete:** The transaction committed, but the token could not be fully verified yet.

Do not expose private keys, raw signed transactions, or unbounded RPC error bodies.

## 12. Testing

### 12.1 Unit tests

- Metadata trimming and UTF-8 byte-length validation, including multibyte boundaries.
- Decimal and supply parsing, including zero and `i128::MAX` bounds.
- Funding calculation and zero-fee factory validation.
- Workflow creation, persistence, migration rejection, and step transitions.
- Retry behavior for pre-submission, invalid, committed failure, committed success, and indeterminate results.
- Funding recovery from fresh, partially funded, committed, and uncertain states.
- Stale-tab rejection after reloading workflow and chain state inside the account lock.
- Factory configuration trust checks.
- Event and post-creation verification.
- Persona parsing, preference scoping, and private-key omission.

### 12.2 Component tests

- Create form validation and live preview.
- Loading, insufficient-balance, progress, uncertain, failure, and success states.
- Persona switching remounts workflow state and updates administrator/holder.
- Global and creator-filtered token directory loading, empty, populated, truncated, and partial-failure states.
- Wallet switcher and portfolio behavior.
- Keyboard navigation and accessible names.

### 12.3 Configuration and security tests

- Development credentials are injected only for loopback `vite serve`.
- Build and preview omit private keys.
- Non-loopback development hosts fail when credentials are enabled.
- RPC proxy enforces origin, target, method, content type, and size restrictions.

### 12.4 Local acceptance test

On a clean local ledger:

1. Run setup and start the app configuration.
2. Create a token as Alice.
3. Verify prediction, funding, receipt return, event, metadata, supply, and balance.
4. Switch to Bob and create the same metadata with a different nonce.
5. Verify the address differs, each persona sees only their own launches in the filtered view, and the global directory includes both launches.

Deterministic workflow and component tests cover refresh after funding, uncertain creation, stale tabs, and unavailable verification views. The opt-in live acceptance journey covers delayed event indexing with bounded polling. These tests must preserve transaction evidence and prevent duplicate submissions.

## 13. Acceptance Criteria

- `apps/token-launchpad` builds and type-checks independently.
- The app visually matches the Groundhog AMM family and uses shadcn/ui throughout.
- Alice, Bob, and Carol can be selected using the same wallet interaction as the swap app.
- A valid form predicts an address and presents exact reviewed costs.
- Automatic mode advances a recoverable funding, creation, and verification workflow in one user flow; manual mode advances one transaction at a time.
- A successful creation displays and persists the created address and evidence.
- Tokens discovers all indexed current-factory events; My Tokens applies the active creator filter; both read current wallet balance state.
- Invalid input, insufficient HOG, declared contract errors, committed failures, and uncertain transactions have distinct feedback.
- No private key enters a production build or public React context.
- Mobile, tablet, and desktop layouts are usable without overflow.
- Unit, component, typecheck, and production-build checks pass.

## 14. Review Decisions

The implementation review made these scope decisions:

- Require metadata instead of exposing the contract's nullable metadata options; a launchpad-created token should be identifiable.
- Limit decimals to 18 in the UI while retaining the contract's broader ABI range; this keeps human amount parsing practical.
- Default administrator and holder to the active wallet rather than exposing raw address inputs in v1; this avoids accidental loss of authority or supply.
- Reject nonzero-fee factories in v1; safe fee support also requires allowance-row funding, residual allowance cleanup, and recovery UX.
- Persist the nonce and each transaction step because the DevWallet cannot batch the workflow.
- Treat event discovery as the token directory because the factory intentionally stores no token registry.
- Explicitly retain the local factory initialization warning as a release blocker rather than disguising the two-transaction setup as safe deployment tooling.
