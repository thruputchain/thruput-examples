# Groundhog Swap Frontend MVP
Status: Draft

Date: 2026-07-30

## 1. Scope
Build **Groundhog Swap**, a local-development web app for the existing Uniswap V2-style swap contracts. The MVP supports exact-input swaps between one configured ERC20 pair through a development wallet and an already-running local Groundhog node.

The app must:

- Show token balances, pool reserves, and exact-input quotes in both directions.

- Let the user configure slippage and approve the handler for the exact input amount.

- Submit swap requests through the router without manually encoded calldata.

- Distinguish an enqueued request from an executed swap.

- Use external CLI queue processing; the app will not crank the driver.

- Poll filtered pair `SwapEvent`s as the primary execution signal, then refresh balances and reserves.

### Success Criteria
- One command deploys and configures a funded two-token pool against a running local node.

- A user can approve and enqueue an exact-input swap from the browser.

- Quotes match the contract's integer calculation, including the 0.3% swap fee, in both directions.

- The UI never presents a committed router request as an executed swap.

- The app is fully responsive and works on mobile and desktop.

- Automated tests cover amount conversion, quote and slippage math, token ordering, transaction outcomes, and swap workflow transitions.

### Non-Goals
- Exact-output swaps.

- Pool discovery, arbitrary token addresses, or multi-hop routing.

- Pool creation or liquidity management in the UI.

- An in-app crank, keeper, or keeper incentives.

- A production wallet provider, devnet deployment, or production custody.

- Additional behavioral contract changes beyond the request-ID lifecycle already present in the configured swap suite.

## 2. User Flow
1. The developer starts a compatible local Groundhog node and runs the setup command.

2. Setup deploys the contracts, creates and seeds one pool, funds the development account, and writes local app configuration.

3. The app loads the account, network, token metadata, balances, allowance, and pair reserves.

4. The user selects a direction and enters an exact input amount.

5. The app shows the estimated output, minimum output, rate, 0.3% fee rate, price impact, and adjustable slippage.

6. The user clicks **Approve & swap**. If needed, the app approves the handler for the exact input amount, waits for that allowance to be observed, and then automatically submits the swap.

7. The app submits `swap_exact_tokens_for_tokens` through the router without requiring a second user action.

8. After a successful committed receipt, the app displays **Queued for execution**.

9. From `apps/swap`, the developer runs `bash scripts/crank-local.sh`, which calls the configured pair driver's `process_requests()` entrypoint through the generated CLI profile.

10. The app observes a matching pair `SwapEvent`, displays **Execution observed**, and refreshes balances and reserves.

## 3. Product Requirements
### Account And Pool State
- Show the abbreviated account address and local-network status.

- Show both token symbols, balances, and the selected direction.

- Read reserves from `SwapPair::get_reserves` and orient them to the selected direction.

- Distinguish loading, missing configuration, unavailable RPC, and empty-liquidity states.

- Provide manual refresh.

### Swap Input And Quote
- Accept decimal input and convert it to base units without JavaScript floating-point arithmetic.

- Reject empty, malformed, zero, excessive-precision, balance-exceeding, and zero-output amounts.

- Reject inputs or required allowance deltas that do not fit the ERC20 contract's signed `i128` difference type.

- Provide direction switching and a Max action.

- Refresh the quote when reserves change and show when a refresh is in progress.

- Display estimated output, minimum output, exchange rate, 0.3% swap fee rate, and price impact including the fee.


Use the contract's exact-input formula:

```text
amountInWithFee = amountIn * 997
quotedAmountOut = floor(
  amountInWithFee * reserveOut
  / (reserveIn * 1000 + amountInWithFee)
)
```

Calculate price impact against the fee-free reserve ratio:

```text
spotAmountOut = floor(amountIn * reserveOut / reserveIn)
priceImpactBps = floor(
  (spotAmountOut - quotedAmountOut) * 10_000 / spotAmountOut
)
```

Omit price impact when `spotAmountOut` is zero.
### Slippage
- Default to 0.5% (50 basis points).

- Provide presets and a custom value greater than 0% and no greater than 50%.

- Limit custom values to two decimal places so they map to whole basis points.

- Warn above 5%.

- Calculate minimum output with integer arithmetic:

  ```text
  amountOutMin = floor(quotedAmountOut * (10_000 - slippageBps) / 10_000)
  ```


The quote is advisory. The handler recalculates output from live reserves when it processes the request. The UI must explain that the displayed output may change, `amountOutMin` is enforced during processing, and a queued request may later fail and be consumed.
### Approval
- Read the input token's allowance for the configured handler.

- When allowance differs from the input amount, submit `adjust_allowance(handler, inputAmount - currentAllowance)` as a separate transaction.

- Use one user action to orchestrate approval and swap submission. Do not submit the swap until approval commits successfully and the updated allowance is observed.

- Do not offer unlimited approval.

### Swap Submission
- Call `swap_exact_tokens_for_tokens(amountIn, amountOutMin, tokenIn, tokenOut, recipient)` on the configured router.

- Use the development account as recipient.

- Track at most one outstanding request for a recipient and pair. Disable another swap until the current request is observed or the developer confirms that an external crank consumed the request and drained the relevant queue.

- Prevent duplicate submission while signing or submitting.

- Transition to **Queued for execution** only after a successful committed receipt.

- Explain that `process_requests()` must be called externally with `bash scripts/crank-local.sh`.

### Execution Observation
- Capture the request ID from the enqueue receipt, then poll pair `SwapEvent`s and driver `RequestFailed` events after enqueue.
- Filter successful execution by request ID, pair, handler, recipient, direction, exact input, and `amountOutMin`.
- On a match, display **Execution observed** with actual amounts and refresh balances, allowance, and reserves.
- After two minutes without a match, remain **Queued; execution not observed**; absence does not prove failure.
- If event querying is unavailable, infer execution only when one snapshot shows input balance and allowance reduced by `amountIn`, output balance increased by at least `amountOutMin`, and reserves moved accordingly.

### Interface
Build a single-page, Uniswap-inspired interface with shadcn/ui:

- Compact header with app name, local-network status, and account address.

- Centered swap card with token panels, balances, direction switch, and contextual primary action.

- Slippage settings popover or sheet.

- Collapsible details for rate, fee, price impact, minimum output, handler, and pair.

- Persistent transaction status after submission.

- Persistent warning that the browser-exposed development key is for local use only.


Accessibility requirements:

- Keyboard access, visible focus, accessible names, and non-color status indicators.

- An `aria-live` region for meaningful status changes, excluding repeated polling updates.

- Touch targets of at least 44 by 44 CSS pixels.

- Reduced-motion support.

## 4. Technical Requirements
### Stack And Structure
- Create the app at `apps/swap` with Vite, React, and TypeScript.

- Use shadcn/ui primitives without creating a broad shared component library.

- Separate contract adapters, Groundhog client and wallet code, amount and quote utilities, and workflow state.

- Use `bigint` for all contract amounts. Never convert base-unit values through `number`.

### Contract Integration
Provide typed adapters for:

- ERC20 `get_balance_of`, `allowance`, `adjust_allowance`, and metadata views.

- Swap pair `get_reserves`.

- RPC `getEvents` and pair `SwapEvent` decoding.

- Swap router `swap_exact_tokens_for_tokens`.


Generate or validate bindings against built contract specifications; do not hand-code entrypoint selectors. Adapters must decode typed view returns and distinguish returns, aborts, and faults.

Generate event codecs from the built pair and driver specifications. Wrap generated decoders with strict application-level validation for topic counts, payload lengths, request IDs, addresses, direction, and amounts.

Query events in ascending order strictly after the enqueue receipt's block, follow cursors, and deduplicate by `(txHash, sequenceNumber)`.

Pair reserves use canonical token0/token1 address ordering. Adapters must orient reserves to the UI's selected input and output tokens.
### Wallet And Transactions
Every state-changing call uses the development wallet/account as the root invocation and relays the target call through its configured `doAction` entrypoint.

Use a minimal replaceable wallet boundary:

```ts
interface WalletAdapter {
  getAddress(): Promise<ContractAddress>
  signTransaction(transaction: Transaction): Promise<SignedTransaction>
}
```

The MVP adapter may wrap the TypeScript client's private-key signer. This interface is not a specification for the future wallet provider.

For each transaction:

- Create a fresh nonce and an expiry beyond the current chain tip.

- Sign canonical transaction bytes.

- Derive and retain the pinned runtime's canonical hash before submission; verify that the RPC-returned hash matches.

- Use status to determine inclusion and the committed receipt's execution result to determine success.

- Treat pending as nonterminal, invalid as authoritative failure, and unknown or recent conflict diagnostics as indeterminate.

- Preserve the hash and signed transaction after submission.

- Never create a fresh automatic retry after a timeout, unknown status, recent conflict, or ambiguous disconnect; the original may still commit.

- Allow a fresh retry only after definitive pre-submission failure or authoritative invalid status.


Model workflow explicitly:

```text
idle, quoting, ready_to_approve, approving, ready_to_swap,
submitting, indeterminate, queued, execution_observed,
queued_not_observed, error
```

Approval and submission may enter `error` or `indeterminate`; queued observation may enter `execution_observed` or `queued_not_observed`. Error state must retain the transaction phase, hash when available, outcome certainty, and retry eligibility. An indeterminate submitted transaction must not return to a freely resubmittable state.
### Configuration
Validate these local environment values at startup:

```text
VITE_GROUNDHOG_RPC_URL
VITE_GROUNDHOG_NETWORK_ID
VITE_GROUNDHOG_WALLET_ADDRESS
VITE_GROUNDHOG_WALLET_ENTRYPOINT
VITE_SWAP_ROUTER_ADDRESS
VITE_SWAP_PAIR_ADDRESS
VITE_SWAP_HANDLER_ADDRESS
VITE_SWAP_DRIVER_ADDRESS
VITE_TOKEN_A_ADDRESS
VITE_TOKEN_B_ADDRESS
```

The local development server reads `GROUNDHOG_DEV_PRIVATE_KEY` from the ignored `.env.local` file and injects it only while serving against a loopback RPC. Production builds must not contain the key. The key and wallet entrypoint remain browser-visible while the local app runs, so treat them as public development credentials. Refuse signing and submission unless both the application page and RPC hostnames are loopback. Read token metadata on-chain when available and allow generated configuration fallbacks.

Validate the configured network identity before accepting snapshots or signing. The pinned transaction format has no network-ID field, so it cannot be included in signed bytes. Require loopback application and RPC origins for V1.
### Local Setup
Provide one command that assumes a compatible local node is running and:

1. Builds ERC20 with metadata and all swap guest artifacts.

2. Deploys and funds two ERC20 contracts, initializes metadata, and mints balances.

3. Deploys, funds, and initializes the factory with the suite hashes and `fee_to = None`.

4. Deploys, funds, and initializes the router.

5. Predicts and pre-funds the pair, LP token, handler, and driver addresses.

6. Creates the pair, seeds balanced liquidity, and processes the add-liquidity request.

7. Resolves the wallet's `doAction` entrypoint and writes addresses and metadata to generated configuration.

8. Derives the disposable local key from the fresh development runtime manifest, writes it to an ignored environment file, and verifies that it authorizes the configured wallet with a smoke transaction.

9. Writes the generated driver and `process_requests()` entrypoint configuration consumed by `bash scripts/crank-local.sh`.


The command only needs to support a clean local ledger.
### Client Compatibility
Pin compatible node, RPC wire, TypeScript client, ERC20 interface, and generated swap-specification versions.

Before UI implementation, a smoke test must prove:

- Chain-tip and typed view return, abort, and fault decoding.

- ERC20 balance and allowance reads.

- Pair reserve reads.

- Development-wallet authorization and `doAction` relay through a successful committed receipt.

- Router calldata acceptance.

- Filtered `SwapEvent` querying, decoding, and pagination through `groundhog_getEvents`.

### Security
- Treat the app and key as local-development-only.

- Never commit or log private keys, funded credentials, or signed transaction bytes.

- Deterministic, unfunded cryptographic fixtures may include a clearly labeled synthetic key and signed bytes when both Rust and TypeScript consume the same vector. Runtime and setup code must never use fixture credentials.

- Construct swap requests only through the router.

- Use exact allowances. This limits exposure but does not fix the contracts' direct driver/handler authorization weakness.

- Do not add analytics or external telemetry.

## 5. Testing
Unit tests:

- Decimal parsing and formatting.

- Exact-input quote, price impact, slippage, and rounding.

- Token ordering and reserve orientation.

- Allowance-difference calculation, including reducing excess allowance.

- Transaction outcome mapping, safe retry rules, and workflow transitions.

- `SwapEvent` filter construction, strict decoding, request matching, and event deduplication.

- Balance and reserve fallback observation without inferring failure on timeout.


Component tests:

- Amount validation and direction switching.

- One-click approval-and-swap orchestration, including approval-required and approval-satisfied states.

- Queued messaging, durable one-outstanding-request enforcement, and `bash scripts/crank-local.sh` instructions.

- Configuration, RPC, and transaction error states.


One local integration test must execute:

```text
load state -> one user click -> approve exact amount if needed -> enqueue exact-input swap
-> externally process requests -> match SwapEvent -> refresh balances and reserves
```
## 6. Request Lifecycle Decision
The configured contracts return a unique request ID and emit `RequestAccepted`, request-correlated success events, and `RequestFailed`. The frontend persists that ID and treats it as the authoritative lifecycle correlation key. It still limits the browser workflow to one outstanding request per recipient and pair to prevent accidental duplicate submissions.
