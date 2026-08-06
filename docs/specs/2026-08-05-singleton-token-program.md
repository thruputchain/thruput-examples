# Groundhog Token Program V1
Status: Draft  
Date: 2026-08-05
## 1. Summary
Build a canonical singleton token program for Groundhog. One deployed program manages many fungible token mints, token accounts, balances, authorities, and storage bonds. Users create standard tokens through contract calls rather than writing and deploying one contract per token.

The program follows the broad SPL Token model while adapting it to Groundhog:

- A token is identified by the token program address and a mint ID.
  
- Balances live in explicit, funded token accounts.
  
- Transfers never create persistent state implicitly.
  
- Mint creation collects a permanent identity-storage bond and refundable active-state bond. Token-account creation collects a refundable storage bond.
  
- Frequently updated amounts use independent `NNInt` storage entries to preserve Groundhog's commutative execution properties.
  
- Rich or custom token behavior remains the domain of separately deployed contracts.
  

The program charges no protocol, launch, or product fee. It collects only storage bonds required to keep its state funded.
## 2. Goals
- Let users create standard fungible tokens without deploying custom contracts.
  
- Support millions of mints without a global counter, registry vector, or other hot storage key.
  
- Make every persistent storage allocation intentional, funded, attributable, and closable.
  
- Prevent dust transfers from forcing the program to create unpaid storage.
  
- Give wallets, CLIs, launchpads, and indexers one stable token interface.
  
- Support token ownership by wallets and contracts.
  
- Preserve parallel execution across unrelated mints and token accounts.
  
- Keep the canonical program small enough to audit and deploy immutably.
  
- Keep independently deployed ERC20 contracts available for tokens requiring custom behavior.
  
### Success Criteria
- A user can create a mint, its initial token account, and an optional initial supply through the canonical program without deploying another contract.
  
- A user can create, fund, discover, use, and close token accounts.
  
- Storage-growing operations collect sufficient HOG before committing state.
  
- Closing eligible active state returns its recorded refundable bond to the original bond payer.
  
- Transfers between existing accounts create no persistent state and require no storage bond.
  
- Unrelated transfers do not touch global mutable storage.
  
- Mint supply always equals minted units minus burned units.
  
- No global administrator can mint, freeze, seize, or reassign user assets.
  
- Generated Rust and TypeScript clients can construct every V1 operation without hand-encoded calldata.
  
- Automated tests cover authorization, lifecycle, storage solvency, bounds, rollback, and concurrent execution.
  
## 3. Non-Goals
- Transfer taxes, automatic fees, or royalties.
  
- Rebasing or interest-bearing balances.
  
- Transfer hooks or arbitrary callbacks.
  
- Blacklists beyond an optional per-mint freeze authority.
  
- Confidential balances or transfers.
  
- Non-fungible or semi-fungible tokens.
  
- Rich mutable metadata stored in the token program.
  
- Global uniqueness for token names or symbols.
  
- On-chain enumeration of every mint, account, or holder.
  
- Automatic creation of destination accounts during ordinary transfers.
  
- Migration of existing ERC20 balances into the token program.
  
- Protocol-level transaction sponsorship.
  
- Zero-HOG token creation.
  
- A permanently upgradeable canonical ledger.
  
## 4. Design Principles
### Explicit State Creation
Every mint and token account is created through a dedicated operation that collects its storage bond. Transfers, minting, burning, delegation, freezing, and authority changes operate on existing records.
### Minimal Shared Mutation
No operation updates a global mint count, account vector, holder count, transaction count, or event index. Indexers discover activity from events.
### Fixed Core Semantics
V1 provides a conservative fungible-token feature set. Tokens requiring taxes, hooks, rebasing, custom authorization, or other programmable behavior use an independent contract or a future specialized token program.
### Authority Isolation
Each mint controls its own optional authorities. The token program has no administrator with access to mint state or balances.
### Versioned Immutability
The deployed V1 program is immutable after audit. A future V2 uses a different program address. Asset identity includes the program address, so versions can coexist.
## 5. Terminology
| Term | Meaning |
| --- | --- |
| Token program | The singleton contract that implements this specification. |
| Mint | The configuration, authorities, and supply for one fungible token. |
| Mint ID | A deterministic hash identifying a mint within one token program. |
| Asset ID | The pair `(program address, mint ID)` identifying a token across programs. |
| Token account | A persistent account holding one mint for one owner. |
| Associated token account | The canonical deterministic token account for one `(mint, owner)` pair. |
| Additional token account | A non-canonical token account derived with an owner-selected nonce. |
| Storage bond | HOG collected to fund persistent state. Active-state bonds are refundable; mint identity bonds remain locked with permanent tombstones. |
| Bond payer | The caller that funds an object's storage bond. |
| Refund recipient | The address recorded at creation and paid when the object closes. |
| Owner | The address authorized to transfer and burn a token account's balance. |
| Delegate | One optional address authorized to transfer a bounded amount from a token account. |
## 6. Identifiers
### Types
```rust
pub type MintId = SHA256Hash;
pub type TokenAccountId = SHA256Hash;
pub type Amount = u128;
pub const MAX_AMOUNT: Amount = i128::MAX as u128;
pub type Name = heapless::String<100>;
pub type Symbol = heapless::String<10>;
pub type MetadataUri = heapless::String<256>;

#[contract_type]
pub struct AssetId {
    pub program: ContractAddress,
    pub mint: MintId,
}
```

`AssetId` is the ecosystem-level token identifier. Interfaces that may handle canonical tokens, future token-program versions, or independent token contracts must not identify an asset with a bare mint ID.

Every balance, supply, cap, allowance, and operation amount must not exceed `MAX_AMOUNT`. This bound matches the signed `NNInt` adjustment path and must be enforced consistently by contracts and clients.
### Mint IDs
The program derives a mint ID from its own address, the caller, and a caller-selected nonce:

```text
MintId = SHA256-XDR(
  "groundhog-token-mint-v1",
  tokenProgramAddress,
  creatorAddress,
  creatorNonce
)
```

Creator-scoped nonces avoid a global sequence. A caller and nonce always derive the same mint ID; creation fails if that mint exists.

Names and symbols do not participate in identity and need not be unique.
### Associated Token Accounts
The canonical account for an owner and mint is:

```text
TokenAccountId = SHA256-XDR(
  "groundhog-associated-token-account-v1",
  tokenProgramAddress,
  mintId,
  ownerAddress
)
```

Anyone may fund and create an associated account for another owner. The derived owner and mint are immutable.

An associated account may be recreated after closure. Its mint and owner remain identical because they are part of the derivation.
### Additional Token Accounts
An owner may have additional accounts:

```text
TokenAccountId = SHA256-XDR(
  "groundhog-token-account-v1",
  tokenProgramAddress,
  mintId,
  ownerAddress,
  accountNonce
)
```

Anyone may fund and create an additional account for another owner. The same tuple always derives the same ID; creation fails if the account exists.

An additional account may be recreated after closure only from the same mint, owner, and nonce tuple. Recreation starts with zero balance, no delegate, and a new storage bond.

All hash preimages must use canonical XDR encoding and distinct domain separators exactly as specified.
## 7. Mint Model
### Immutable Configuration
```rust
#[contract_type]
pub struct MintConfig {
    pub decimals: u8,
    pub max_supply: Option<Amount>,
    pub name: Name,
    pub symbol: Symbol,
    pub metadata_uri: Option<MetadataUri>,
    pub creator: ContractAddress,
    pub refundable_bond_amount: Amount,
    pub refund_to: ContractAddress,
}

#[contract_type]
pub struct MintTombstone {
    pub creator: ContractAddress,
    pub creation_commitment: SHA256Hash,
    pub identity_bond_amount: Amount,
}
```

The following fields are immutable:

- `decimals`
  
- `max_supply`
  
- `name`
  
- `symbol`
  
- `metadata_uri`
  
- `creator`
  
- `refundable_bond_amount`
  
- `refund_to`
  

`decimals` is display metadata only. All program arithmetic uses integer base units.

`max_supply` is an optional immutable cap. When present, the total supply must never exceed it. Removing or increasing a cap is not supported.

Names contain at most 100 UTF-8 bytes, symbols contain at most 10 UTF-8 bytes, and metadata URIs contain at most 256 UTF-8 bytes. Names and symbols must be nonempty. V1 stores no arbitrary key-value metadata.
### Mutable Mint State
Each mint ID permanently retains one `MintTombstone`. While active or closing, it also stores these values in separate entries:

```rust
supplies: Map<MintId, NNInt>,
remaining_mint_capacity: Map<MintId, NNInt>,
mint_authorities: Map<MintId, Value<Option<ContractAddress>>>,
freeze_authorities: Map<MintId, Value<Option<ContractAddress>>>,
close_authorities: Map<MintId, Value<Option<ContractAddress>>>,
mint_statuses: Map<MintId, Value<MintStatus>>,
account_counts: Map<MintId, NNInt>,
```

```rust
#[contract_type]
pub enum MintStatus {
    Active,
    Closing,
}

#[contract_type]
pub enum AuthorityType {
    Mint,
    Freeze,
    Close,
}
```

`remaining_mint_capacity` starts at `max_supply - initial_supply` for capped mints and `MAX_AMOUNT - initial_supply` otherwise. Minting decrements capacity, and burning restores it. This independently bounded `NNInt` makes cap enforcement safe under concurrent minting.

The tombstone's commitment hashes the canonical creation configuration. A tombstone permanently prevents reuse of a closed mint ID and lets indexers distinguish a formerly valid mint from an ID that never existed.

The mint authority may mint new units and may permanently revoke or transfer its authority.

The freeze authority may freeze and thaw token accounts for that mint and may permanently revoke or transfer its authority.

The close authority may begin, cancel, and complete mint closure. It may permanently revoke or transfer its authority while the mint is active.

No authority can be restored after being set to `None`.
## 8. Token Account Model
### Immutable Configuration
```rust
#[contract_type]
pub struct TokenAccountConfig {
    pub mint: MintId,
    pub owner: ContractAddress,
    pub bond_amount: Amount,
    pub refund_to: ContractAddress,
    pub kind: TokenAccountKind,
}

#[contract_type]
pub enum TokenAccountKind {
    Associated,
    Additional,
}
```

The mint, owner, account kind, bond amount, and refund recipient cannot change. To move assets to a new owner, transfer the balance to that owner's account and close the old account.

Immutable ownership preserves deterministic associated-account discovery and prevents account takeover.
### Mutable Account State
Each account allocates these independent entries at creation:

```rust
balances: Map<TokenAccountId, NNInt>,
frozen: Map<TokenAccountId, Value<bool>>,
delegate_addresses: Map<TokenAccountId, Value<Option<ContractAddress>>>,
delegate_allowances: Map<TokenAccountId, NNInt>,
```

The account bond funds all four entries from creation, including empty delegation state. Approving a first delegate therefore creates no new storage.

Each account supports at most one delegate. Setting a new delegate replaces the previous delegate and allowance atomically.

Frozen accounts cannot send, receive, mint, burn, approve, revoke, or execute delegated transfers. A zero-balance frozen account may still close so a freeze authority cannot permanently trap its storage bond.
## 9. Storage Layout
The intended logical layout is:

```rust
#[sdk::storage]
pub struct TokenProgram {
    mint_tombstones: Map<MintId, Value<MintTombstone>>,
    mint_configs: Map<MintId, Value<MintConfig>>,
    supplies: Map<MintId, NNInt>,
    remaining_mint_capacity: Map<MintId, NNInt>,
    mint_authorities: Map<MintId, Value<Option<ContractAddress>>>,
    freeze_authorities: Map<MintId, Value<Option<ContractAddress>>>,
    close_authorities: Map<MintId, Value<Option<ContractAddress>>>,
    mint_statuses: Map<MintId, Value<MintStatus>>,
    account_counts: Map<MintId, NNInt>,

    account_configs: Map<TokenAccountId, Value<TokenAccountConfig>>,
    balances: Map<TokenAccountId, NNInt>,
    frozen: Map<TokenAccountId, Value<bool>>,
    delegate_addresses: Map<TokenAccountId, Value<Option<ContractAddress>>>,
    delegate_allowances: Map<TokenAccountId, NNInt>,
}
```

Implementation may reorganize fields only if it preserves:

- Independent `NNInt` keys for balances, supply, account counts, and delegate allowances.
  
- An independent `NNInt` remaining-capacity key for concurrency-safe supply limits.
  
- No global mutable key on ordinary mint or account operations.
  
- Fixed storage allocation for all mutable account features at account creation.
  
- Complete deletion of token-account keys and active mint keys when they close.
  
- Permanent retention of one immutable tombstone for every created mint ID.
  
- Exclusive creation and deletion of object identity keys.
  
- Stable external behavior and deterministic identifiers.
  
## 10. Storage Economics
### Bond Schedule
V1 compiles these immutable bond amounts into the program:

```rust
#[contract_type]
pub struct StorageBondSchedule {
    pub mint_identity: Amount,
    pub mint_active_state: Amount,
    pub associated_account: Amount,
    pub additional_account: Amount,
}
```

The permanent mint identity bond includes:

- Mint tombstone key and value.
  
- Creator, creation commitment, and identity bond amount.
  

The refundable mint active-state bond includes:

- Mint configuration.
  
- Supply.
  
- Remaining mint capacity.
  
- Three authority entries.
  
- Mint lifecycle status.
  
- Account count.
  
- All key and encoding overhead attributable to those records.
  

Each account bond includes:

- Account configuration.
  
- Balance.
  
- Frozen state.
  
- Delegate address.
  
- Delegate allowance.
  
- All key and encoding overhead attributable to those records.
  

Metadata has bounded maximum lengths. The mint active-state bond must cover the maximum valid encoded mint configuration so every valid mint pays one predictable amount.

Bond constants must be derived from the pinned network storage-cost model and verified by tests. The program exposes them through read-only methods.
### Collecting Bonds
Before writing storage for an object, the program must collect that object's published bond from the caller. Existing program funds do not grant creation credit.

V1 collects bonds through the native token's allowance and `transfer_from` interface:

```text
bond payer grants the token program an exact native-HOG allowance
-> token program pulls the required bond
-> token program creates the object
```

For public V1 creation methods, `get_caller()` is both the bond payer and refund recipient.

A wallet or launchpad may wrap the approval and operation in a higher-level workflow, but the token program must enforce payment itself. Pre-funding the program does not grant creation credit to a caller.

The transfer and storage creation occur in one contract call tree. Any failure after the transfer must revert the transfer and all state changes.
### No Revenue
The program collects no amount beyond the published storage bond. It has no fee recipient and no withdrawal method for an administrator or operator.

Uncommitted HOG backs outstanding bond liabilities and is not protocol revenue.
### Bond Refunds
When a token account closes, the program deletes all storage funded by its bond and transfers exactly `bond_amount` to `refund_to`. When a mint closes, the program deletes its active state and transfers exactly `refundable_bond_amount`; its tombstone and identity bond remain permanently.

The refund recipient is the original bond payer, even when that payer created an account for another owner. Account ownership does not imply ownership of the storage bond.

Refund rights are immutable in V1. This prevents an account owner from redirecting a sponsor's refundable bond.

Implementation gate 5 must prove that deletion-unlocked HOG and an outgoing bond refund settle atomically. If that gate fails, revise this specification to define a two-step close-and-claim lifecycle before implementation. V1 must not rely on an unverified commit-order assumption.
### Solvency
For every open object:

```text
recorded refundable bond liability = object.refundable bond amount
```

Mint identity bonds are not refund liabilities because their tombstones never close.

The program must never expose a method that transfers HOG except a valid refundable-bond payment. Tests must show that any sequence of valid creation and closure operations can repay all recorded refundable bonds.

V1 bond constants target a pinned storage-cost model. If the network can reprice existing storage after deployment, the immutable program requires a documented network-level guarantee or a new token-program version before production use.
## 11. Contract Interface
The following signatures are normative at the semantic level. Exact borrowing and generated-client details may follow SDK conventions.
### Creation Types
```rust
#[contract_type]
pub struct CreateMintConfig {
    pub decimals: u8,
    pub max_supply: Option<Amount>,
    pub name: Name,
    pub symbol: Symbol,
    pub metadata_uri: Option<MetadataUri>,
    pub mint_authority: Option<ContractAddress>,
    pub freeze_authority: Option<ContractAddress>,
    pub close_authority: Option<ContractAddress>,
    pub initial_holder: ContractAddress,
    pub initial_supply: Amount,
}

#[contract_type]
pub struct CreatedMint {
    pub mint: MintId,
    pub initial_account: TokenAccountId,
}

#[contract_type]
pub struct MintView {
    pub config: MintConfig,
    pub supply: Amount,
    pub remaining_mint_capacity: Amount,
    pub mint_authority: Option<ContractAddress>,
    pub freeze_authority: Option<ContractAddress>,
    pub close_authority: Option<ContractAddress>,
    pub status: MintStatus,
    pub account_count: Amount,
}

#[contract_type]
pub struct TokenAccountView {
    pub config: TokenAccountConfig,
    pub balance: Amount,
    pub frozen: bool,
    pub delegate: Option<ContractAddress>,
    pub delegate_allowance: Amount,
}
```
### Interface
```rust
#[contract(client = TokenProgramClient, throws(TokenProgramError))]
pub trait TokenProgram {
    fn create_mint(
        &mut self,
        nonce: &SHA256Hash,
        config: CreateMintConfig,
    ) -> CreatedMint;

    fn create_associated_account(
        &mut self,
        mint: &MintId,
        owner: &ContractAddress,
    ) -> TokenAccountId;

    fn create_account(
        &mut self,
        mint: &MintId,
        owner: &ContractAddress,
        nonce: &SHA256Hash,
    ) -> TokenAccountId;

    fn transfer(
        &mut self,
        source: &TokenAccountId,
        destination: &TokenAccountId,
        amount: Amount,
    );

    fn approve_delegate(
        &mut self,
        account: &TokenAccountId,
        delegate: &ContractAddress,
        allowance: Amount,
    );

    fn revoke_delegate(&mut self, account: &TokenAccountId);

    fn transfer_as_delegate(
        &mut self,
        source: &TokenAccountId,
        destination: &TokenAccountId,
        amount: Amount,
    );

    fn mint_to(
        &mut self,
        mint: &MintId,
        destination: &TokenAccountId,
        amount: Amount,
    );

    fn burn(&mut self, account: &TokenAccountId, amount: Amount);

    fn set_mint_authority(
        &mut self,
        mint: &MintId,
        new_authority: Option<ContractAddress>,
    );

    fn set_freeze_authority(
        &mut self,
        mint: &MintId,
        new_authority: Option<ContractAddress>,
    );

    fn set_close_authority(
        &mut self,
        mint: &MintId,
        new_authority: Option<ContractAddress>,
    );

    fn freeze_account(&mut self, account: &TokenAccountId);
    fn thaw_account(&mut self, account: &TokenAccountId);
    fn close_account(&mut self, account: &TokenAccountId);
    fn begin_mint_close(&mut self, mint: &MintId);
    fn cancel_mint_close(&mut self, mint: &MintId);
    fn close_mint(&mut self, mint: &MintId);

    fn predict_mint(
        &self,
        creator: &ContractAddress,
        nonce: &SHA256Hash,
    ) -> MintId;

    fn associated_account(
        &self,
        mint: &MintId,
        owner: &ContractAddress,
    ) -> TokenAccountId;

    fn predict_account(
        &self,
        mint: &MintId,
        owner: &ContractAddress,
        nonce: &SHA256Hash,
    ) -> TokenAccountId;

    fn get_mint(&self, mint: &MintId) -> Option<MintView>;
    fn get_mint_tombstone(&self, mint: &MintId) -> Option<MintTombstone>;
    fn get_account(&self, account: &TokenAccountId) -> Option<TokenAccountView>;
    fn balance(&self, account: &TokenAccountId) -> Option<Amount>;
    fn supply(&self, mint: &MintId) -> Option<Amount>;
    fn bond_schedule(&self) -> StorageBondSchedule;
}
```

Views return complete bounded structures suitable for generated clients. After mint closure, `get_mint` returns `None` and `get_mint_tombstone` returns the permanent identity record. Missing-object views return `None`; mutating operations on missing objects throw typed errors.
## 12. Operation Semantics
### Create Mint
`create_mint`:

1. Derives the mint ID from the current program address, caller, and nonce.
  
2. Rejects an existing mint ID.
  
3. Validates metadata lengths, amount bounds, authorities, supply cap, and initial supply.
  
4. Derives the initial holder's associated account and rejects it if already present.
  
5. Pulls the mint identity bond, mint active-state bond, and one associated-account bond from the caller.
  
6. Creates the permanent tombstone and every active mint storage entry.
  
7. Creates every initial account storage entry.
  
8. Sets mint status to `Active` and account count to one.
  
9. Sets initial account balance and total supply to `initial_supply`.
  
10. Sets remaining mint capacity to the effective cap minus `initial_supply`.
  
11. Records the caller as creator and refund recipient for both bonds.
  
12. Emits `MintCreated` and `TokenAccountCreated`. When initial supply is nonzero, it also emits `Minted` and `Transfer`.
  
13. Returns both IDs.
  

The initial account is always created, including when initial supply is zero. This gives every mint a predictable first holder account and makes the total creation bond deterministic.

`initial_supply` and `max_supply` must not exceed `MAX_AMOUNT`, and initial supply must not exceed a configured cap.

Mint tombstones and initial-account identity entries use exclusive creation semantics. Concurrent calls deriving either same ID cannot both commit, even when they write identical values. Any existing tombstone permanently rejects mint recreation.
### Create Token Account
Both account-creation methods:

1. Require the mint to exist.
  
2. Require the mint status to be `Active`.
  
3. Derive the account ID.
  
4. Reject an existing account ID.
  
5. Pull the published account bond from the caller.
  
6. Create configuration, zero balance, unfrozen state, no delegate, and zero allowance.
  
7. Increment the mint's account count.
  
8. Record the caller as refund recipient.
  
9. Emit `TokenAccountCreated`.
  

The owner need not authorize account creation because creation grants the owner control and costs the bond payer, not the owner.

The account identity entry uses exclusive creation semantics. Its creation must conflict with another creation of the same ID, closure of that ID, and a transition of the mint from `Active` to `Closing`.
### Transfer
`transfer` requires:

- Source and destination accounts exist.
  
- Both accounts belong to the same mint.
  
- Caller equals the source owner.
  
- Neither account is frozen.
  
- Amount is positive and representable as a signed balance difference.
  
- Source has sufficient balance.
  

The operation decrements the source and increments the destination, then emits `Transfer`.

Self-transfer is valid only after all authorization, frozen-state, amount, and balance checks pass. It produces no net balance change but emits the transfer event.
### Delegation
`approve_delegate` requires the account owner, an unfrozen account, and mint status `Active`. It replaces any existing delegate and allowance and emits `DelegateChanged`. The delegate must not be the zero address, and allowance must be positive and no greater than `MAX_AMOUNT`.

`revoke_delegate` requires the account owner and an unfrozen account. If a delegate exists, it clears the delegate and allowance and emits `DelegateChanged`; otherwise, it succeeds without changing state or emitting an event.

`transfer_as_delegate` requires:

- Caller equals the source account's current delegate.
  
- Source and destination share a mint.
  
- Neither account is frozen.
  
- Amount is positive.
  
- Source balance and delegate allowance are sufficient.
  

It decrements allowance and source balance, increments destination balance, and emits `Transfer`. When allowance reaches zero, the delegate address is cleared in the same operation.

A delegated self-transfer performs every authorization, frozen-state, amount, balance, and allowance check. It consumes allowance, makes no net balance change, and emits `Transfer`.

Delegation never grants permission to burn, close, approve another delegate, or change account configuration.
### Mint
`mint_to` requires:

- Mint and destination account exist.
  
- Mint status is `Active`.
  
- Caller equals the current mint authority.
  
- Mint authority is not revoked.
  
- Destination belongs to the mint and is not frozen.
  
- Amount is positive and representable.
  
- Remaining mint capacity is sufficient.
  

It decrements remaining mint capacity and increments destination balance and total supply, then emits `Minted` and `Transfer` with `source = None`.
### Burn
`burn` requires:

- Account and mint exist.
  
- Caller equals account owner.
  
- Account is not frozen.
  
- Amount is positive and representable.
  
- Account balance and total supply are sufficient.
  

It decrements account balance and total supply, restores the same amount of remaining mint capacity, then emits `Burned` and `Transfer` with `destination = None`.

Mint authorities cannot burn a holder's balance without the holder's authorization.
### Authority Changes
Each `set_*_authority` method requires the current authority of that type. It atomically replaces the authority and emits `AuthorityChanged`. `set_close_authority` also requires mint status `Active`; beginning closure fixes the close authority until closure is cancelled or completed.

Setting an authority to `None` permanently revokes it. Calling an authority method after revocation fails. An authority cannot set itself again after revocation.

The zero address is not a valid authority; revocation uses `None`.

A freeze authority can permanently lock nonzero balances by freezing accounts and then revoking or losing its authority. This is an intentional consequence of enabling freezing. Mint-creation and authority-management tooling must present this power prominently.
### Freeze and Thaw
`freeze_account` and `thaw_account` resolve the account's mint and require that mint's current freeze authority.

Freezing an already frozen account and thawing an already active account succeed idempotently and emit no event. A state change emits `FrozenStateChanged`.
### Close Token Account
`close_account` requires:

- Account exists.
  
- Balance is zero.
  
- Caller equals the account owner, or the mint is `Closing` and caller equals its close authority.
  

The operation:

1. Clears any delegate and allowance.
  
2. Deletes every account storage entry.
  
3. Decrements the mint's account count.
  
4. Transfers the recorded bond to `refund_to`.
  
5. Emits `TokenAccountClosed`.
  

A frozen zero-balance account may close. Closing never transfers token units.

Account deletion uses exclusive lifecycle semantics. It must conflict with balance, delegate, frozen-state, or identity mutations for the same account. A concurrent or repeated close can delete and refund at most once.
### Begin or Cancel Mint Closure
`begin_mint_close` requires the current close authority and mint status `Active`. It atomically changes status to `Closing` and emits `MintStatusChanged`.

While a mint is closing:

- New token accounts cannot be created.
  
- New units cannot be minted.
  
- Existing accounts may transfer, execute existing delegated transfers, burn, revoke delegates, freeze, thaw, and close.
  
- The close authority may close any zero-balance account, including an account created for an inaccessible owner.
  
- The close authority cannot be changed or revoked.
  

`cancel_mint_close` requires the close authority and status `Closing`. It returns the mint to `Active` and emits `MintStatusChanged`.

The transition from `Active` to `Closing` must conflict with concurrent account creation and minting for that mint.
### Close Mint
`close_mint` requires:

- Mint exists.
  
- Caller equals the current close authority.
  
- Close authority is not revoked.
  
- Mint status is `Closing`.
  
- Total supply is zero.
  
- Account count is zero.
  

The operation deletes every active mint storage entry, retains the immutable tombstone, refunds the mint active-state bond to `refund_to`, and emits `MintClosed`.

Mint deletion uses exclusive lifecycle semantics and must conflict with every mint mutation. It cannot race with account creation, minting, authority changes, or another close.

Revoking close authority makes the mint permanently non-closable. This is valid, but tooling must warn that its storage bond will remain locked indefinitely.
## 13. Invariants
Every successful operation must preserve these invariants. An abort, fault, nested-call rollback, or rejected concurrent execution must leave them unchanged:

1. Every existing account references an existing mint.
  
2. An associated account ID uniquely identifies its program, mint, and owner.
  
3. An additional account ID uniquely identifies its program, mint, owner, and nonce.
  
4. An account's mint and owner never change.
  
5. Account balances, supply, account counts, and delegate allowances never become negative.
  
6. Total supply equals the sum of all open account balances for the mint.
  
7. Supply plus remaining mint capacity equals `max_supply` when capped and `MAX_AMOUNT` otherwise.
  
8. Minting changes supply, remaining capacity, and one destination balance by the same amount.
  
9. Burning changes supply, remaining capacity, and one source balance by the same amount.
  
10. Transfers preserve supply and preserve the sum of all balances for the mint.
  
11. Delegated transfers cannot exceed the recorded allowance.
  
12. A revoked authority can never act or be restored.
  
13. Frozen accounts cannot participate in balance-changing operations.
  
14. Account count equals the number of open accounts for the mint.
  
15. A closing mint cannot create accounts or mint units.
  
16. Closed token accounts leave no live storage keys and may be recreated only with the same derived mint and owner.
  
17. Closed mints leave exactly one immutable tombstone and can never be recreated.
  
18. Every open object retains one recorded refundable bond liability.
  
19. Every mint tombstone retains its permanent identity bond.
  
20. Only object closure can pay a bond refund.
  
21. A failed operation leaves native HOG, token state, bonds, and events unchanged.
  
22. No operation depends on enumerating all accounts or mints.
  
## 14. Events
Events are the canonical discovery and history mechanism. Every event includes the token program address implicitly through the emitting contract.

```rust
pub struct MintCreated {
    pub mint: MintId,
    pub creator: ContractAddress,
    pub initial_account: TokenAccountId,
    pub initial_holder: ContractAddress,
    pub initial_supply: Amount,
    pub decimals: u8,
    pub name: Name,
    pub symbol: Symbol,
}

pub struct TokenAccountCreated {
    pub account: TokenAccountId,
    pub mint: MintId,
    pub owner: ContractAddress,
    pub bond_payer: ContractAddress,
    pub kind: TokenAccountKind,
}

pub struct Transfer {
    pub mint: MintId,
    pub source: Option<TokenAccountId>,
    pub destination: Option<TokenAccountId>,
    pub authority: ContractAddress,
    pub amount: Amount,
}

pub struct Minted {
    pub mint: MintId,
    pub destination: TokenAccountId,
    pub authority: ContractAddress,
    pub amount: Amount,
}

pub struct Burned {
    pub mint: MintId,
    pub source: TokenAccountId,
    pub owner: ContractAddress,
    pub amount: Amount,
}

pub struct MintStatusChanged {
    pub mint: MintId,
    pub authority: ContractAddress,
    pub status: MintStatus,
}

pub struct DelegateChanged {
    pub account: TokenAccountId,
    pub owner: ContractAddress,
    pub delegate: Option<ContractAddress>,
    pub allowance: Amount,
}

pub struct AuthorityChanged {
    pub mint: MintId,
    pub authority_type: AuthorityType,
    pub previous: ContractAddress,
    pub current: Option<ContractAddress>,
}

pub struct FrozenStateChanged {
    pub account: TokenAccountId,
    pub mint: MintId,
    pub frozen: bool,
    pub authority: ContractAddress,
}

pub struct TokenAccountClosed {
    pub account: TokenAccountId,
    pub mint: MintId,
    pub owner: ContractAddress,
    pub refund_to: ContractAddress,
    pub bond_amount: Amount,
}

pub struct MintClosed {
    pub mint: MintId,
    pub refund_to: ContractAddress,
    pub refunded_bond_amount: Amount,
}
```

`Transfer.source = None` represents minting. `Transfer.destination = None` represents burning. Ordinary transfers set both.

Events do not include a post-operation supply because concurrently merged supply deltas can make an execution-local total misleading. Indexers derive deltas from events and confirm current supply through `supply()`.

Events must be declared in contract interface metadata so clients generate typed decoders. Indexers use `(transaction hash, event sequence)` as the stable event identity.
## 15. Errors
V1 exposes typed, non-overlapping errors. V1 assigns each error a unique numeric code before release and never reuses a code within the V1 interface.

| Error | Meaning |
| --- | --- |
| `MintAlreadyExists` | Derived mint ID is already occupied. |
| `MintNotFound` | Mint does not exist. |
| `AccountAlreadyExists` | Derived token-account ID is already occupied. |
| `AccountNotFound` | Token account does not exist. |
| `MintMismatch` | Source, destination, or explicit mint do not agree. |
| `Unauthorized` | Caller lacks the required owner or authority role. |
| `AuthorityRevoked` | The required authority is `None`. |
| `InvalidAuthority` | An authority value is invalid, including the zero address. |
| `AccountFrozen` | Operation is prohibited while an account is frozen. |
| `MintNotActive` | Operation requires an active mint. |
| `MintNotClosing` | Operation requires a closing mint. |
| `InvalidAmount` | Amount is zero where positive value is required. |
| `AmountTooLarge` | Amount cannot be represented by the storage adjustment path. |
| `InsufficientBalance` | Source account lacks token balance. |
| `InsufficientAllowance` | Delegate allowance is too small. |
| `SupplyCapExceeded` | Mint would exceed its effective cap. |
| `SupplyNotZero` | Mint cannot close while supply remains. |
| `AccountCountNotZero` | Mint cannot close while accounts remain. |
| `BalanceNotZero` | Token account cannot close while it holds units. |
| `InvalidMetadata` | Bounded metadata validation failed. |
| `InvalidSupplyConfiguration` | Initial supply and cap are inconsistent. |
| `StoragePaymentFailed` | Required native HOG bond could not be collected. |
| `StorageRefundFailed` | A valid close could not settle its bond refund. |

Native-token call failures may propagate as their declared typed errors when the interface system supports them. The token-program interface must document every propagated exception type.
## 16. Concurrency Requirements
### Transfers
An ordinary transfer touches only:

- Source account configuration and frozen state for reads.
  
- Destination account configuration and frozen state for reads.
  
- Source balance decrement.
  
- Destination balance increment.
  

It does not mutate mint configuration, supply, account count, or global state.
### Delegated Transfers
A delegated transfer additionally reads the delegate address and decrements its allowance.
### Mint and Burn
Mint and burn mutate one account balance, supply, and remaining mint capacity. They do not rewrite mint configuration.
### Account Lifecycle
Account creation and closure mutate only the account's keys, that mint's status dependency, and its account count. They do not touch other mints or global lists. Identity creation, identity deletion, and mint lifecycle transitions use exclusive conflict semantics.
### Required Concurrency Tests
- Independent transfers on unrelated accounts commute.
  
- Transfers for unrelated mints commute.
  
- Concurrent credits to one destination merge correctly.
  
- Concurrent debits that exceed a source balance cannot both commit.
  
- Concurrent delegate transfers cannot exceed allowance.
  
- Concurrent mint operations cannot exceed supply cap.
  
- Concurrent account creation with the same ID commits at most once.
  
- Concurrent account closures commit at most once and refund once.
  
- Concurrent mint creation with the same ID commits at most once and collects one bond.
  
- Beginning mint closure conflicts with account creation and minting.
  
- Closing an account conflicts with transfers, burns, delegation, freeze changes, and another close.
  
- Closing a mint conflicts with every mutation of that mint.
  
- Account creation and mint closure cannot produce an orphan account.
  
- All valid execution interleavings produce identical state and event roots.
  
## 17. Security Requirements
- Use checked conversion from `Amount` to signed storage differences.
  
- Reject any amount, balance, supply, cap, allowance, or bond above `MAX_AMOUNT`.
  
- Reject every arithmetic overflow and underflow before state commit.
  
- Validate mint equality before changing any balance.
  
- Perform authorization checks before native-token or token-balance mutation.
  
- Collect bonds before creating state, within the same revertible call tree.
  
- Delete every refundable active-state key before issuing its refund; retain the permanent mint tombstone.
  
- Never infer authorization from the bond payer or refund recipient.
  
- Never allow mint authority to burn holder funds.
  
- Never allow freeze authority to seize, transfer, burn, close, or redirect a bond.
  
- Never let a delegate approve another delegate or close an account.
  
- Do not invoke user-controlled contracts during token operations.
  
- Emit events only after all validations and state changes succeed.
  
- Keep metadata bounded and validate it before collecting payment.
  
- Domain-separate every identifier hash.
  
- Reject the zero address for owners, delegates, and authorities. Represent minting and burning in `Transfer` events with `None`.
  
- Expose no global withdrawal, rescue, or administrative balance mutation.
  
## 18. Client and Ecosystem Requirements
### Rust Interface Crate
Create a dedicated interface crate containing:

- IDs and amount aliases.
  
- Contract traits and generated clients.
  
- Creation, view, authority, and event types.
  
- Typed errors.
  
- Deterministic ID helpers usable by contracts and off-chain tools.
  

The deployable implementation depends on this interface crate. Other protocols depend on the interface crate, not the implementation.
### TypeScript Client
Generated TypeScript bindings must expose:

- Every state-changing operation and view.
  
- `bigint` amounts without conversion through JavaScript `number`.
  
- Deterministic mint and account derivation.
  
- Typed event decoding.
  
- Typed abort and fault outcomes.
  
### CLI
The initial CLI must support:

```text
token mint create
token mint show
token mint set-authority
token mint begin-close
token mint cancel-close
token mint close
token account create
token account show
token account close
token balance
token transfer
token approve
token revoke
token mint-to
token burn
token freeze
token thaw
```

Creation commands must:

- Display the derived ID before signing.
  
- Display required storage bonds.
  
- Warn when close authority is omitted or revoked.
  
- Warn that names and symbols are not unique.
  
- Set exact native-token allowance for the required bond.
  
- Wait for authoritative completion before submitting the creation call.
  
- Never silently retry an ambiguously submitted transaction with a fresh nonce.
  
### Indexing
Indexers, not the token program, provide:

- Mint enumeration.
  
- Accounts by owner.
  
- Accounts by mint.
  
- Holder lists.
  
- Transfer history.
  
- Name and symbol search.
  
- Verification and reputation metadata.
  

The indexer must derive state from typed events and confirm current state through program views when needed.
## 19. Deployment and Versioning
- Deploy one canonical V1 program address per network.
  
- Publish the exact program address, contract hash, interface version, bond schedule, and source revision.
  
- Audit the implementation before designating it canonical.
  
- Do not place V1 behind an upgradeable proxy.
  
- A replacement program uses a new address and interface version.
  
- Existing V1 assets remain valid under their original `AssetId`.
  
- Ecosystem code must allow more than one recognized token program.
  
- Verification registries may designate recommended program versions without changing asset identity.
  
## 20. Testing
### Identifier Tests
- Mint derivation is deterministic and creator-scoped.
  
- Associated account derivation is deterministic.
  
- Additional account derivation changes with nonce.
  
- Every derivation is domain-separated.
  
- Rust and TypeScript produce identical IDs from shared vectors.
  
### Mint Tests
- Create mint with zero and nonzero initial supply.
  
- Create fixed-supply mint with revoked mint authority.
  
- Reject duplicate mint ID.
  
- Reject initial supply above cap.
  
- Reject invalid metadata and authorities before payment.
  
- Mint within cap and reject mint above cap.
  
- Concurrent mints cannot exceed the effective cap.
  
- Burning restores exactly the corresponding mint capacity.
  
- Transfer and revoke each authority.
  
- Prove revoked authority cannot be restored.
  
- Begin and cancel mint closure.
  
- Reject account creation and minting while closure is active.
  
- Close only while status is `Closing` and supply and account count are zero.
  
### Account Tests
- Create associated and additional accounts.
  
- Let a third party fund an account for another owner.
  
- Reject duplicate account.
  
- Recreate a closed account with the same immutable mint and owner and a fresh bond.
  
- Reject account creation for missing mint.
  
- Preserve immutable owner and mint.
  
- Close active and frozen zero-balance accounts.
  
- Let the close authority close a zero-balance account for an inaccessible owner while the mint is closing.
  
- Reject close with nonzero balance.
  
- Refund the original bond payer rather than owner when they differ.
  
### Balance Tests
- Transfer exact, partial, and full balances.
  
- Reject zero, oversized, insufficient, cross-mint, frozen, and unauthorized transfers.
  
- Validate self-transfer behavior.
  
- Mint and burn update supply and balance together.
  
- Supply equals the sum of all open account balances after every operation.
  
- Mint authority cannot burn holder funds.
  
- Supply remains unchanged by transfers.
  
### Delegate Tests
- Approve, replace, revoke, and exhaust a delegate.
  
- Reject unauthorized or excessive delegated transfer.
  
- Validate delegated self-transfer and allowance consumption.
  
- Clear delegate when allowance reaches zero.
  
- Prevent delegate burn, close, freeze, and authority changes.
  
- Reject delegation changes while frozen.
  
### Storage Tests
- Creation pulls exactly the published bond.
  
- Failed validation pulls no HOG.
  
- Native transfer failure creates no state.
  
- Failure after bond transfer reverts payment and state.
  
- Mint and account bonds cover worst-case valid encodings.
  
- Account operations after creation allocate no new keys.
  
- Account closure deletes every account key; mint closure deletes every active mint key and retains one tombstone.
  
- Closing refunds exactly one recorded bond.
  
- Concurrent or repeated close cannot refund twice.
  
- Aggregate program HOG remains sufficient for all open bond liabilities.
  
- Create-close cycles conserve HOG under the pinned cost model.
  
### Authorization Tests
- Owners, delegates, and each mint authority can perform only their specified operations.
  
- The creator has no implicit powers beyond configured authorities.
  
- Bond payer and refund recipient gain no token authority.
  
- Zero addresses are rejected for owners, delegates, and authorities.
  
- Immediate contract callers, including wallets and protocols, are handled consistently.
  
### Rollback Tests
- Typed abort after intermediate mutation leaves no state or events.
  
- Native-token transfer and object creation roll back together.
  
- Nested call failure cannot retain a bond without its object.
  
- Refund failure leaves the object and its recorded liability unchanged.
  
- Faults and storage conflicts preserve every invariant.
  
### Integration Lifecycle
One cost-enabled integration test must execute:

```text
fund creator
-> approve exact mint and account bonds
-> create capped mint and initial account
-> create recipient account funded by a third party
-> transfer
-> approve delegate
-> delegated transfer
-> mint to recipient
-> freeze and thaw recipient
-> burn all balances
-> revoke authorities not needed for closure
-> begin mint closure
-> close both accounts, including one by its bond payer and one by close authority
-> close mint
-> verify storage deletion and bond refunds
```

After each state-changing step, the test verifies emitted events, affected balances, supply, remaining capacity, account count, native HOG changes, and the presence or absence of affected objects.
## 21. Implementation Gates
Before full implementation, complete a focused runtime spike that proves:

1. The exact native token address and interface used by contracts.
  
2. A token program can pull HOG from the caller through `transfer_from` and use it for storage in the same transaction.
  
3. Failure after the pull reverts both the native transfer and storage writes.
  
4. Deleting all keys for an account releases the expected HOG under the pinned cost model.
  
5. The program can transfer a full recorded bond during the same transaction as deletion. If not, this specification must be revised with a complete two-step close-and-claim lifecycle before implementation.
  
6. The chosen bounded metadata types have stable maximum encoded sizes.
  
7. Creating all fixed account entries prevents later delegation and freeze operations from increasing storage cost.
  
8. The SDK's `NNInt` and signed difference path supports every value through `MAX_AMOUNT`.
  
9. The interface macro can declare and generate every propagated native-token and token-program error.
  
10. Events are present in generated contract metadata and decode identically in Rust and TypeScript.
  

No production bond constants may be selected before these measurements pass under the pinned storage-cost model.
## 22. Acceptance
V1 is ready for canonical deployment when:

- All implementation gates pass.
  
- The interface and identifier vectors are frozen.
  
- Unit, native integration, RPC integration, concurrency, and cross-language tests pass.
  
- Storage bonds are measured and published.
  
- The program has no global administrative asset authority or HOG withdrawal path.
  
- The contract hash and source revision are reproducible.
  
- An independent security review finds no unresolved critical or high-severity issue.
  
- Rust and TypeScript clients are published against the same interface version.
  
- The CLI completes the full lifecycle on a clean cost-enabled network.
  
- Documentation explains asset identity, account creation, authority revocation, bond refunds, and immutable versioning.
