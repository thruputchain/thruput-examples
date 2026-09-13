# Thruput Counter: proposed approach

## Recommendation

Build `apps/counter` as a small, single-page app. Use the existing Thruput theme, a server-signed development account, and one shared counter contract. Make each button press or captured keydown submit one transaction that changes the counter by one.

The main design choice is to separate input, submission, and confirmation. Users should be able to keep pressing keys while earlier transactions are still in flight.

## What the repository supports

- `contracts/counter/src/implementation.rs` already provides `increment(amount)`, `decrement(amount)`, and `get()`. Its `NNInt` storage supports commutative updates: concurrent changes can merge without an application-level read/modify/write loop.
- The counter is non-negative. `contracts/counter/tests/test.rs` explicitly tests an underflow failure. Start the demo at **1,000,000**, and display the actual value. Keep values as `bigint` in the client.
- `initialize()` adds to the value; it is not a reset or a guarded, one-time initializer. Call it only when provisioning a fresh deployment, never on page load or setup reruns against an existing instance.
- Increment and decrement do not emit events or return the new value. Track transaction outcomes through receipts and refresh the counter through `get()`.
- Swap and Launchpad use React 19, TypeScript, Vite, Tailwind 4, IBM Plex fonts, and the same dark Thruput theme.
- Before wallet integration, the apps used `PrivateKeySigner` in the browser. The installed client SDK now provides `createPubkeyAccount`, `createWalletClient`, and explicit prepare/sign/submit methods. Use those current APIs rather than restore the old hand-built DevWallet wrapper.
- The SDK generates random transaction nonces; it does not require a sequential nonce lookup for every submission. It also accepts an explicit expiry height, so a shared, refreshed chain tip can replace a per-key tip request.
- The existing apps' RPC proxies are read-only. This app needs its own submission-capable RPC path.

These are source-review findings. Live burst performance and same-account contention still need measurement.

## Screen

Use the existing header treatment: the lime lightning mark, **THRUPUT / Counter**, and a small network/readiness indicator.

The main content has three parts:

1. **A large counter value**, labelled as the latest chain value. Keep the number stable and readable while updates arrive.
2. **Two large controls: − Decrement and + Increment.** Both remain usable while transactions are pending. Below them, a focusable keyboard area says: “Press any key. Send a transaction.”
3. **A compact activity section** with this session's submitted count, confirmed count, pending count, and confirmed transactions per second. Show failures or unknown results when present. Keep only a short recent-transaction list, with explorer links.

Use the current colors: near-black `#10110f`, olive surfaces, lime `#e9ef64`, and warm off-white text. Use IBM Plex Mono for numbers and headings, and IBM Plex Sans for body text. Keep the layout comfortable on mobile, where the two buttons provide the main interaction.

A brief +1/−1 input pulse provides immediate feedback. The large number remains chain-backed; it does not pretend that an input or an accepted submission has committed. Respect reduced-motion preferences.

## Keyboard behavior

- Clicking the keyboard area focuses it and starts capture. Make that active state clear. This is an interaction surface, not an approval step.
- Each captured keydown independently chooses increment or decrement with equal probability. Use an amount of one.
- Allow key repeat, so holding a key also sends transactions.
- Escape ends capture. Tab keeps normal focus navigation. Preserve browser/system shortcuts and ignore modifier-only keys and composition events.
- Scope capture to the keyboard area. Enter or Space on an increment/decrement button must activate that button once, without also sending a random transaction.
- Leaving the area, switching tabs, or losing window focus stops new keyboard input. Already submitted transactions continue to be observed.

This gives users a place to smash keys while preserving normal page controls.

## Signing and setup

Use one generated, funded development account per app deployment. Keep the key on the server. A signing endpoint accepts only an increment or decrement direction and fixes the counter target and amount to one. There is no connect-wallet flow or per-transaction prompt.

This replaces the original browser-key design after security review. Existing public keys must be replaced, not merely hidden. Each setup run creates a fresh counter and funded signer, then writes a private environment file. The disposable demo does not need a deployment journal or recovery workflow.

Add `setup:local` to build the counter, generate its TypeScript bindings, provision the account, fund the contract's storage, deploy it, initialize it, and write the app configuration. Verify the resulting counter value before reporting readiness.

Configuration should identify the RPC endpoint, expected network, counter address, development signer, and optional explorer URL. Validate the network and deployment before enabling input. Show a useful connection or funding error when startup fails.

Use one shared counter per configured deployment. Everyone sees the same chain value; activity metrics describe only the current browser session. This keeps setup simple and shows concurrent access to the same state.

## Transaction pipeline

Keep the transaction engine separate from React. Use a single Web Worker for signing requests, submission, and observation so bursts do not compete with rendering on the main thread.

1. **Accept input.** Record one operation and send it to the engine immediately.
2. **Prepare and sign.** Request a fixed ±1 invocation from the server. The server uses the SDK's default account adapter, assigns a random nonce, and sets an expiry from a recent chain tip. The browser receives the signed transaction and computes its hash before submission. Preparation itself does not submit.
3. **Submit concurrently.** Use a bounded pool of active submission requests. Release a submission slot when its RPC request finishes, not when the transaction confirms.
4. **Observe separately.** Use one scheduler with bounded receipt/status checks for outstanding hashes. Do not create an independent high-frequency polling loop for every key press.
5. **Refresh the view.** Read `get()` on a shared cadence, initially around 250–500 ms during activity and less often while idle. Prevent older responses from replacing newer state.
6. **Publish UI snapshots.** Send compact state updates to React at a bounded rate, such as 20 times per second. Keep animation and rendering independent of transaction count.

Start with a modest submission pool, for example 16 active requests, then tune it from a live burst test. Bound the input queue and unresolved transaction set too. If capacity is reached, show “At capacity” and count inputs that were not accepted; do not silently drop them or accumulate an unlimited backlog. This is capacity control, not a debounce: every accepted input still represents one transaction.

If a send response is lost or confirmation times out, retain the known hash and show an unknown outcome. Do not generate a replacement transaction automatically, because the original may have executed. Back off observation during an outage and stop accepting new input until the connection is usable.

At zero, disable manual decrement based on the latest read. Random decrements can still race with other users and fail; report those failures honestly rather than silently change their direction. The initial headroom makes this unusual in normal use.

## What the demo measures

Label the rate **“This session · confirmed tx/s.”** Calculate it over a stated rolling window, such as the last five seconds. It measures successful confirmations observed by this browser, not the network's maximum throughput.

If latency is included, call it **“Observed confirmation time”**: it includes RPC and polling delay. Keep setup/funding transactions out of the session statistics.

The final counter alone is a poor activity signal because random increments and decrements cancel out. The confirmed total and live rate are what make the amount of work visible.

## Implementation scope

- Add `apps/counter` to the npm workspaces, using the pinned dependencies and command conventions already in the repository. Use port 5175 for local development.
- Keep a small structure: app UI, theme/components, generated counter bindings, configuration/client setup, transaction engine/worker, setup scripts, and a thin static server/RPC proxy for deployment.
- Reuse the theme and only the UI primitives this screen needs. A router, registry, indexer, and database are unnecessary for this page.
- Give the proxy the read methods needed for readiness, counter views, and transaction observation, plus signed-transaction submission. Validate submitted payloads against the two fixed wallet-wrapped ±1 counter calls; reject other targets, entrypoints, amounts, wrappers, and attached code. Keep funding in setup.
- Include a short README and deployment configuration consistent with the other apps.

## Verification before calling it complete

1. Check setup on a fresh node, then run increment and decrement through the generated bindings and development signer.
2. Submit a known mix concurrently. Confirm every successful hash and check that the final value equals the starting value plus successful increments minus successful decrements, on an isolated deployment.
3. Verify that submission continues while receipts are delayed. Check duplicate prevention, lost send responses, queue capacity, underflow, stale reads, and network loss.
4. Use browser checks for held keys, mixed key presses, Escape/Tab, button keyboard activation, focus loss, responsive layout, and responsive rendering during a burst.
5. Run the app's tests, typecheck, and production build, then the workspace checks affected by its addition.

Measure the first burst with the proposed single signer and shared counter. The counter supports concurrent updates, but the complete account-execution, RPC, and receipt path may impose other limits. Use those measurements to tune the client; do not promise a throughput number from the contract design alone.

## Defaults to review

- **One shared counter**, initialized to **1,000,000**.
- **One private server-side development signer** provisioned by setup.
- **Focus-to-smash**, with key repeat enabled and Escape to leave.
- **One input = one ±1 transaction**, with concurrent submission.
- **Chain-backed number and session-only metrics**.

These defaults keep the app small while making Groundhog's concurrent transaction processing visible.
