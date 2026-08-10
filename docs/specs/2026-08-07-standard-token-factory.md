# Groundhog Standard Token Factory V1
Status: Draft  
Date: 2026-08-07
## 1. Summary
Build an on-chain factory that deploys one standard ERC-20 contract for each created token. Every token receives its own contract address, storage namespace, balances, allowances, administrator, and event stream.

The caller chooses token metadata, administrator, initial holder, and initial supply. The caller cannot choose implementation code. The factory always deploys one fixed, audited ERC-20 implementation hash.

The factory supports an optional creation fee. The official Groundhog factory configures it to zero. The creator separately funds the predicted token address with the HOG required for deployment and initial storage.
## 2. V1 Decisions
- Preserve the existing `groundhog-erc20-if` interface unchanged.
  
- Deploy a real ERC-20 contract for every token.
  
- Use the token contract address as complete token identity.
  
- Store balances and allowances directly by Groundhog address.
  
- Deploy only one immutable implementation hash from each factory version.
  
- Initialize the token in the same transaction as deployment.
  
- Use a typed `TokenCreated` event for discovery instead of a factory registry map.
  
- Require the creator to pre-fund the deterministic token address.
  
- Keep custom ERC-20 deployments available outside the factory.
  

V1 does not include arbitrary implementations, taxes, hooks, rebasing, freezing, blacklists, liquidity creation, or implementation upgrades.
## 3. Contracts and Interfaces
### Standard Token
The deployed token implements the exact ERC-20 interface and behavior pinned by `FactoryConfig.erc20_interface_version`:

```text
initialize
transfer
transfer_from
adjust_allowance
allowance
get_balance_of
get_balance
mint
burn
total_supply
```

The source of truth is the published `groundhog-erc20-if` artifact for that version. Factory tokens and native HOG must use the same method selectors, event signatures, error encoding, amount bounds, self-transfer behavior, and allowance semantics.

The token also implements the complete existing metadata interface, including its initializer:

```rust
pub trait ERC20Metadata {
    fn initialize(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
    );
    fn name(&self) -> Option<Name>;
    fn symbol(&self) -> Option<Symbol>;
    fn decimals(&self) -> Option<u32>;
}
```

All token initializers share one initialization guard.
### Factory Initializer
The standard token adds one factory-specific initializer without changing ERC-20:

```rust
pub trait StandardTokenInitializer {
    fn initialize_from_factory(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    );
}
```

It succeeds exactly once, stores the requested administrator directly, and creates `initial_supply` in `initial_holder`. A nonzero initial supply emits the standard mint `TransferEvent`.

After it succeeds, both existing ERC-20 initializers fail with `AlreadyInitialized`. The factory never becomes token administrator.
### Types
`Amount`, `Difference`, `Name`, `Symbol`, `ContractAddress`, and ERC-20 events and errors come from the pinned interface and SDK artifacts. V1 uses the existing limits of `Name = heapless::String<100>` and `Symbol = heapless::String<10>`.
## 4. State
### Standard Token
```rust
#[sdk::storage]
pub struct StandardToken {
    config: Value<TokenConfig>,
    balances: Map<ContractAddress, NNInt>,
    allowances: Map<ContractAddress, Map<ContractAddress, NNInt>>,
    total_supply: NNInt,
}

#[contract_type]
pub struct TokenConfig {
    pub administrator: ContractAddress,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
}
```

This remains deliberately close to the existing ERC-20 example. Metadata is immutable. Administrator authorization follows the pinned ERC-20 interface, including its current mint and burn semantics.

The initializer always creates the initial holder balance entry, including when initial supply is zero, so initial storage cost is predictable.
### Factory
```rust
#[sdk::storage]
pub struct StandardTokenFactory {
    config: Value<FactoryConfig>,
}

#[contract_type]
pub struct FactoryConfig {
    pub token_code_hash: SHA256Hash,
    pub erc20_interface_version: InterfaceVersion,
    pub required_token_funding: Amount,
    pub native_token: ContractAddress,
    pub creation_fee: Amount,
    pub fee_recipient: Option<ContractAddress>,
}
```

Factory configuration is written once and never changes. A zero fee requires no recipient. A nonzero fee requires a nonzero recipient. The factory stores no per-token records and exposes no administrator, upgrade, or withdrawal method.

The canonical factory is deployed, funded, and initialized by release tooling in one transaction. Initialization rejects a zero token hash, zero native-token address, unsupported interface version, zero funding requirement, repeated call, or invalid fee-recipient combination.
## 5. Factory Interface
```rust
pub trait StandardTokenFactory {
    fn initialize(&mut self, config: FactoryConfig);

    fn create_token(
        &mut self,
        nonce: &SHA256Hash,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) -> ContractAddress;

    fn predict_token(
        &self,
        creator: &ContractAddress,
        nonce: &SHA256Hash,
    ) -> ContractAddress;

    fn required_token_funding(&self) -> Amount;
    fn creation_fee(&self) -> Amount;
    fn config(&self) -> FactoryConfig;
}
```
## 6. Deterministic Address
The factory computes:

```rust
let deployment_nonce = (
    "groundhog-standard-token-factory-v1",
    creator,
    nonce,
).hash();

let token = get_deploy_address(
    &deployment_nonce,
    &config.token_code_hash,
);
```

The tuple uses canonical XDR encoding through the pinned SDK `Hash` implementation.

Groundhog includes the current deployer in contract-address derivation. Inside the factory, that deployer is the factory address. Another contract using the same nonce and code hash derives a different address and cannot squat a factory child.

`predict_token` and `create_token` must use the same helper. Rust and TypeScript tooling must match shared address vectors.
## 7. Storage Funding
The creator pays for token deployment and initial storage:

1. Call `predict_token(creator, nonce)`.
  
2. Transfer at least `required_token_funding` HOG to the predicted address.
  
3. Call `create_token` with the same nonce.
  

`required_token_funding` is a conservative fixed amount that covers deployment, maximum-length metadata, configuration, supply, and the initial holder balance. It guarantees creation only. Any remainder becomes free storage reserve for later balance and allowance entries.

The funding is not a factory fee. HOG remains at the token address as locked storage backing or free reserve. V1 provides no way to withdraw excess reserve.

A wallet may transfer HOG and call the factory atomically. A CLI may use two transactions and wait for funding to commit before creation. Anyone may top up a token contract later.

If a future storage-cost model changes these requirements, release a new factory with a newly measured funding constant.
## 8. Creation Semantics
`create_token`:

1. Sets `creator = get_caller()`.
  
2. Validates administrator, initial holder, metadata, and initial supply.
  
3. Derives the token address.
  
4. Reads native HOG balance at the predicted address and rejects insufficient funding.
  
5. When configured, transfers exactly `creation_fee` native HOG from the creator to `fee_recipient` using `transfer_from`.
  
6. Deploys the configured token code hash.
  
7. Calls `initialize_from_factory` on the new token.
  
8. Emits `TokenCreated`.
  
9. Returns the token address.
  

Fee collection, deployment, initialization, initial minting, and event emission occur in one call tree. Failure reverts those effects. Funding from an earlier transaction remains at the predicted address so the creator may fix the input and retry with the same nonce. An atomic wallet flow reverts funding when creation fails.

A fee-enabled factory requires the creator to grant an exact native-HOG allowance before `create_token`. The official zero-fee factory skips fee collection and requires no allowance.

At most one creation for a `(factory, creator, nonce)` can commit. A failed creation emits no `TokenCreated` event.
### Validation
- Every 32-byte nonce is valid.
  
- Administrator and initial holder must be nonzero.
  
- Name and symbol bounds are enforced by their types.
  
- Decimals are presentation metadata only.
  
- Initial supply must fit the ERC-20 signed storage-difference bound.
  
- Names and symbols need not be unique.
  
## 9. Discovery
```rust
#[contract_type]
pub struct TokenCreated {
    pub token: ContractAddress,
    pub creator: ContractAddress,
    pub administrator: ContractAddress,
    pub initial_holder: ContractAddress,
    pub initial_supply: Amount,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
    pub token_code_hash: SHA256Hash,
}
```

`TokenCreated` is the canonical discovery record. Indexers filter this event by recognized factory address, then read current metadata and ERC-20 state from the emitted token address.

Transfers and approvals are naturally filterable by token contract address. Names and symbols remain untrusted and non-unique.

Factory provenance proves that the canonical factory created the token with its fixed implementation. It does not imply legitimacy, value, or endorsement.
## 10. Errors
```rust
pub enum TokenFactoryError {
    AlreadyInitialized,
    InvalidConfig,
    InvalidTokenConfig,
    InsufficientTokenFunding,
}
```

Invalid factory configuration maps to `InvalidConfig`. Invalid administrator, holder, metadata, or supply maps to `InvalidTokenConfig`. Insufficient predicted-address HOG maps to `InsufficientTokenFunding`.

Initializer and ERC-20 errors propagate through their declared interfaces. Deployment-system failures propagate as runtime failures and revert creation.
## 11. Security and Versioning
- Deploy and initialize the canonical factory atomically.
  
- Accept no implementation hash in `create_token`.
  
- Validate arguments and funding before deployment.
  
- Initialize the child in the same call tree as deployment.
  
- Share one initialization guard across all token initializers.
  
- Store the requested administrator directly; leave no factory authority.
  
- Use checked amount conversions and canonical address derivation.
  
- Emit `TokenCreated` only after successful initialization.
  
- Expose no factory or token upgrade path.
  
- Transfer configured fees directly to the immutable recipient; retain no fee balance in the factory.
  

One factory address represents one token implementation version. A new implementation or storage-funding requirement uses a new factory. Existing tokens never change or migrate automatically.

Network and client configuration publish recognized factory addresses, implementation hashes, interface versions, required funding, and fee settings. Custom ERC-20 contracts remain valid without factory provenance.
## 12. Client Flow
The CLI and web application use the same flow:

```text
validate inputs
-> predict address
-> display required HOG and creation fee
-> fund predicted address
-> grant exact fee allowance when fee is nonzero
-> call create_token
-> verify returned address and TokenCreated
-> read metadata and supply
```

Tooling must preserve ambiguous transaction state and never automatically submit a fresh nonce when an earlier creation may still commit.
## 13. Testing
Factory tests must cover:

- One-time initialization and immutable configuration.
  
- Shared deterministic-address vectors.
  
- Invalid configuration and token arguments.
  
- Insufficient funding.
  
- Zero and nonzero initial supply.
  
- Optional metadata.
  
- Duplicate and concurrent creation.
  
- Event emission only after successful initialization.
  
- Zero-fee creation without native allowance.
  
- Fee-enabled creation with exact transfer to the immutable recipient.
  

Token tests must cover:

- The pinned standard ERC-20 behavior suite.
  
- Native HOG selector, event, and error parity.
  
- One shared initialization guard.
  
- Correct administrator, metadata, holder, and supply.
  
- No implicit factory authority.
  

Storage tests must prove:

- The published funding covers maximum metadata and initial state under the pinned cost model.
  
- Insufficient funding prevents creation.
  
- Excess remains at the token address.
  
- Future balances and allowances consume only that token’s reserve.
  
- One token cannot consume another token’s reserve.
  

One cost-enabled integration test must execute:

```text
predict
-> fund
-> create
-> verify TokenCreated and provenance
-> mint
-> transfer
-> approve
-> transfer_from
-> burn
-> verify balances, allowance, supply, events, and reserve
```
## 14. Implementation Gates
Before implementation, prove:

1. Contract, Rust, and TypeScript derive the same child address.
  
2. The factory can read predicted-address native HOG before deployment.
  
3. The factory can deploy and initialize the child in one transaction.
  
4. Failure after deployment reverts deployment, initialization, and events.
  
5. Atomic wallet funding reverts when creation fails.
  
6. The fixed funding covers maximum valid initial state.
  
7. A configured fee transfers atomically to the recipient and reverts when creation fails.
  
8. Factory tokens and native HOG use the same published ERC-20 artifacts.
  
9. Factory and token events appear in generated metadata and decode across Rust and TypeScript.
  

V1 is ready when these gates pass, artifacts build reproducibly, required funding and fee configuration are published, tests pass, and an independent security review has no unresolved critical or high-severity issue.
