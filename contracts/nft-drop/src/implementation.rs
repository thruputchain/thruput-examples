//! An NFT drop whose public mints do not conflict with each other.
//!
//! Thousands of mints can land in the same block because no mint reads and
//! rewrites a value that another mint also writes:
//!
//! - **The supply cap is a [`Balance`].** Each mint makes a checked
//!   `decrease(1)`. Decreases to one `Balance` merge, and the runtime admits
//!   only as many as the start-of-block value covers. The drop sells out
//!   exactly; it cannot oversell.
//! - **Token IDs are hashes, not `1, 2, 3`.** A counter would make every mint
//!   write a new value to the same key, so only one mint could land per block.
//! - **Each token has its own keys** for its owner and traits, and the counts
//!   (balances, traits) are `Balance`s that merge.
//!
//! The ERC721 methods follow the `erc721` fixture in `thruput-sdk-rs`.

use core::fmt::Write;

use thruput_erc721_if::*;
use thruput_sdk::call::CallError;
use thruput_sdk::storage::{Balance, Deletable, Map, NNInt, Value};
use thruput_sdk::*;

pub const MAX_SUPPLY: u32 = 10_000;
pub const MAX_TRAITS: usize = 6;
pub const MAX_VALUES: usize = 8;
pub const MAX_WEIGHT: u32 = 10_000;

/// The name of a trait or of one of its values.
pub type Label = heapless::String<24>;

/// The value index a token rolled for each trait, in trait order.
pub type Rolled = VecM<u8, 6>;

#[contract_type]
#[derive(Clone, Debug)]
pub struct TraitValue {
    pub name: Label,
    /// Relative chance of this value. A value with weight 1 among weights
    /// that add up to 100 appears in about 1% of tokens.
    pub weight: u32,
}

#[contract_type]
#[derive(Clone, Debug)]
pub struct Trait {
    pub name: Label,
    pub values: VecM<TraitValue, 8>,
}

/// What a creator chooses for a new drop.
#[contract_type]
#[derive(Clone, Debug)]
pub struct DropDefinition {
    pub name: Name,
    pub symbol: Symbol,
    pub supply: u32,
    pub traits: VecM<Trait, 6>,
}

/// The stored drop configuration. Each trait is stored separately, so every
/// value stays below the local node's 1 KiB limit.
#[contract_type]
#[derive(Clone, Debug)]
pub struct DropConfig {
    pub creator: ContractAddress,
    pub name: Name,
    pub symbol: Symbol,
    pub supply: u32,
    pub trait_count: u32,
}

#[contract_exception]
pub enum DropError {
    AlreadyInitialized = 1,
    InvalidDefinition = 2,
    SoldOut = 3,
}

/// Emitted with the standard [`MintEvent`] for each mint, so an app can draw
/// the token without reading it back.
#[derive(Event, Clone, Debug)]
pub struct TraitsRolled {
    #[topic]
    pub owner: ContractAddress,
    pub token_id: TokenId,
    pub traits: Rolled,
}

#[thruput_sdk::storage]
pub struct NftDrop {
    config: Value<DropConfig>,
    traits: Map<u32, Value<Trait>>,
    /// The supply cap: how many tokens are left.
    remaining: Balance,
    /// The counter half of a token ID. Mints only add to it.
    id_counter: NNInt,
    owners: Map<TokenId, Value<ContractAddress>>,
    rolled: Map<TokenId, Value<Rolled>>,
    balances: Map<ContractAddress, Balance>,
    token_approvals: Map<TokenId, Value<ContractAddress>>,
    operator_approvals: Map<ContractAddress, Map<ContractAddress, Value<bool>>>,
    /// How many tokens rolled each value: `trait_counts[trait][value]`.
    trait_counts: Map<u32, Map<u32, Balance>>,
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn validate(definition: &DropDefinition) {
    let valid_header = !is_blank(&definition.name)
        && !is_blank(&definition.symbol)
        && (1..=MAX_SUPPLY).contains(&definition.supply)
        && (1..=MAX_TRAITS).contains(&definition.traits.len());
    ensure(valid_header, DropError::InvalidDefinition);

    for (index, current) in definition.traits.iter().enumerate() {
        let unique = !definition.traits[..index]
            .iter()
            .any(|other| other.name.trim() == current.name.trim());
        let valid_values = (2..=MAX_VALUES).contains(&current.values.len())
            && current.values.iter().enumerate().all(|(i, value)| {
                !is_blank(&value.name)
                    && (1..=MAX_WEIGHT).contains(&value.weight)
                    && !current.values[..i]
                        .iter()
                        .any(|other| other.name.trim() == value.name.trim())
            });
        ensure(
            unique && !is_blank(&current.name) && valid_values,
            DropError::InvalidDefinition,
        );
    }
}

/// Pick a value for one trait: hash the token ID with the trait index, take a
/// number below the total weight, and find the value whose range holds it.
///
/// A minter can predict this, because the token ID comes from its own
/// transaction. See the README.
fn roll(token_id: &TokenId, index: u32, current: &Trait) -> u8 {
    let seed: SHA256Hash = (token_id, index).hash();
    let total: u32 = current.values.iter().map(|value| value.weight).sum();
    let mut pick = u32::from_le_bytes([seed[0], seed[1], seed[2], seed[3]]) % total;
    for (value_index, value) in current.values.iter().enumerate() {
        if pick < value.weight {
            return value_index as u8;
        }
        pick -= value.weight;
    }
    unreachable!("pick is below the total weight")
}

impl NftDrop {
    fn owner_of_token(&self, token_id: &TokenId) -> Option<ContractAddress> {
        self.owners.at(token_id).try_get().none_if_missing()
    }

    fn require_owned(&self, token_id: &TokenId) -> ContractAddress {
        self.owner_of_token(token_id)
            .unwrap_or_else(|| throw(ERC721Error::NonexistentToken))
    }

    fn approved_for(&self, token_id: &TokenId) -> ContractAddress {
        self.token_approvals
            .at(token_id)
            .try_get()
            .none_if_missing()
            .unwrap_or(*CONTRACT_ADDR_ZERO)
    }

    fn is_operator(&self, owner: &ContractAddress, operator: &ContractAddress) -> bool {
        self.operator_approvals
            .at(owner)
            .at(operator)
            .try_get()
            .none_if_missing()
            .unwrap_or(false)
    }

    fn is_authorized(
        &self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        token_id: &TokenId,
    ) -> bool {
        spender == owner
            || self.is_operator(owner, spender)
            || self.approved_for(token_id) == *spender
    }

    /// Move `token_id` from `from` to `to` for `spender`. Every write to the
    /// token's own keys is exclusive, so two transfers of one token in one
    /// block cannot both land; the balances are deltas, so they merge.
    fn transfer(
        &mut self,
        spender: &ContractAddress,
        from: &ContractAddress,
        to: &ContractAddress,
        token_id: &TokenId,
    ) {
        let owner = self.require_owned(token_id);
        ensure(
            self.is_authorized(&owner, spender, token_id),
            ERC721Error::InsufficientApproval,
        );
        ensure(owner == *from, ERC721Error::IncorrectOwner);

        self.token_approvals.at_mut_exclusive(token_id).delete();
        self.balances.at_mut(from).lazy_decrease(1);
        self.balances.at_mut(to).lazy_increase(1);
        self.owners.at_mut_exclusive(token_id).set(to);

        log_transfer_event(from, to, token_id);
    }

    fn check_on_erc721_received(
        operator: &ContractAddress,
        from: &ContractAddress,
        to: &ContractAddress,
        token_id: &TokenId,
        data: TransferData,
    ) {
        match ERC721ReceiverClient::new(to).try_on_erc721_received(operator, from, token_id, data) {
            Ok(()) => {}
            // No contract at `to`, or one without the hook.
            Err(CallError::Invalid) => throw(ERC721Error::InvalidReceiver),
            Err(err) if err.try_as() == Some(LibraryExn::UnknownMethod) => {
                throw(ERC721Error::InvalidReceiver)
            }
            // The receiver rejected the token: its reason reaches the caller.
            Err(err) => err.re_throw(),
        }
    }
}

#[contract(client = NftDropClient, throws(DropError, ERC721Error), emits(TraitsRolled))]
impl NftDrop {
    /// Store the drop. The factory calls this in the transaction that deploys
    /// the drop, so no one else can initialize it first.
    pub fn initialize(&mut self, creator: &ContractAddress, definition: DropDefinition) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            DropError::AlreadyInitialized,
        );
        validate(&definition);

        for (index, current) in definition.traits.iter().enumerate() {
            self.traits.at_mut(&(index as u32)).set_exclusive(current);
        }
        self.config.set_exclusive(&DropConfig {
            creator: *creator,
            name: definition.name,
            symbol: definition.symbol,
            supply: definition.supply,
            trait_count: definition.traits.len() as u32,
        });
        self.remaining.increase(i128::from(definition.supply));
    }

    /// Mint one token to the caller and return its ID.
    pub fn mint(&mut self) -> TokenId {
        // A snapshot read. Reads are not checked at commit, so they never
        // conflict.
        let config = self.config.get();

        // The supply cap. Every mint in the block decreases this one key. The
        // runtime merges the decreases and admits only as many as the
        // start-of-block value covers. After sell-out, the check fails here.
        self.remaining
            .try_decrease(1)
            .unwrap_or_else(|_| throw(DropError::SoldOut));

        // No shared "next ID". The transaction hash separates concurrent
        // mints, and the counter separates mints in one transaction, as in
        // `helpers/unique-ids`. The drop's address makes IDs unique across
        // drops. The caller separates same-block mints in native tests, where
        // every transaction reports a zero source hash.
        let owner = get_caller();
        self.id_counter.inc(1);
        let token_id: TokenId = (
            get_current_address(),
            owner,
            get_source_transaction_hash(),
            self.id_counter.get(),
        )
            .hash();

        let mut traits = Rolled::default();
        for index in 0..config.trait_count {
            let value = roll(&token_id, index, &self.traits.at(&index).get());
            traits.0.push(value);
            // Every mint increases these few keys. The increases merge.
            self.trait_counts
                .at_mut(&index)
                .at_mut(&u32::from(value))
                .lazy_increase(1);
        }

        self.balances.at_mut(&owner).lazy_increase(1);
        // A new key for each token. The exclusive lock blocks no other mint.
        self.owners.at_mut_exclusive(&token_id).set(&owner);
        self.rolled.at_mut_exclusive(&token_id).set(&traits);

        log_mint_event(&owner, &token_id);
        log_event(&TraitsRolled {
            owner,
            token_id,
            traits,
        });
        token_id
    }

    pub fn get_config(&self) -> DropConfig {
        self.config.get()
    }

    pub fn get_trait(&self, index: u32) -> Trait {
        self.traits.at(&index).get()
    }

    /// Tokens left to mint.
    pub fn remaining(&self) -> u32 {
        self.remaining.get() as u32
    }

    /// How many tokens rolled `value` for trait `index`.
    pub fn trait_count(&self, index: u32, value: u32) -> u32 {
        self.trait_counts.at(&index).at(&value).get() as u32
    }

    /// The value index the token rolled for each trait.
    pub fn traits_of(&self, token_id: &TokenId) -> Rolled {
        self.rolled
            .at(token_id)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(ERC721Error::NonexistentToken))
    }
}

#[contract]
impl ERC721 for NftDrop {
    fn balance_of(&self, owner: &ContractAddress) -> u64 {
        self.balances.at(owner).get() as u64
    }

    fn owner_of(&self, token_id: &TokenId) -> ContractAddress {
        self.require_owned(token_id)
    }

    fn safe_transfer_from(
        &mut self,
        from: &ContractAddress,
        to: &ContractAddress,
        token_id: &TokenId,
        data: TransferData,
    ) {
        let operator = get_caller();
        self.transfer(&operator, from, to, token_id);
        Self::check_on_erc721_received(&operator, from, to, token_id, data);
    }

    fn transfer_from(&mut self, from: &ContractAddress, to: &ContractAddress, token_id: &TokenId) {
        let spender = get_caller();
        self.transfer(&spender, from, to, token_id);
    }

    fn approve(&mut self, to: &ContractAddress, token_id: &TokenId) {
        let caller = get_caller();
        let owner = self.require_owned(token_id);
        ensure(
            caller == owner || self.is_operator(&owner, &caller),
            ERC721Error::InvalidApprover,
        );

        if to == CONTRACT_ADDR_ZERO {
            self.token_approvals.at_mut_exclusive(token_id).delete();
        } else {
            self.token_approvals.at_mut_exclusive(token_id).set(to);
        }
        log_approval_event(&owner, to, token_id);
    }

    fn set_approval_for_all(&mut self, operator: &ContractAddress, approved: bool) {
        let owner = get_caller();
        let mut approvals = self.operator_approvals.at_mut(&owner);
        let mut slot = approvals.at_mut_exclusive(operator);
        if approved {
            slot.set(&true);
        } else {
            slot.delete();
        }
        log_approval_for_all_event(&owner, operator, approved);
    }

    fn get_approved(&self, token_id: &TokenId) -> ContractAddress {
        self.require_owned(token_id);
        self.approved_for(token_id)
    }

    fn is_approved_for_all(&self, owner: &ContractAddress, operator: &ContractAddress) -> bool {
        self.is_operator(owner, operator)
    }
}

#[contract]
impl ERC721Metadata for NftDrop {
    fn name(&self) -> Name {
        self.config.get().name
    }

    fn symbol(&self) -> Symbol {
        self.config.get().symbol
    }

    fn token_uri(&self, token_id: &TokenId) -> TokenUri {
        self.require_owned(token_id);
        throw(ERC721Error::NoTokenUri)
    }

    /// On-chain metadata, built from the stored traits when it is read, so it
    /// costs no storage. The app draws the image from the same traits.
    fn token_metadata(&self, token_id: &TokenId) -> TokenMetadata {
        let rolled = self.traits_of(token_id);
        let config = self.config.get();

        // A full string drops the rest of the text; that only shortens it.
        let mut name = MetadataName::new();
        let _ = write!(name, "{} #", config.name);
        for byte in &token_id[..3] {
            let _ = write!(name, "{byte:02x}");
        }

        let mut description = MetadataDescription::new();
        for (index, value_index) in rolled.iter().enumerate() {
            let current = self.traits.at(&(index as u32)).get();
            let value = &current.values[usize::from(*value_index)];
            let separator = if index == 0 { "" } else { ", " };
            let _ = write!(description, "{separator}{}: {}", current.name, value.name);
        }

        TokenMetadata::Onchain(OnchainMetadata {
            name,
            description,
            image: MetadataImage::new(),
        })
    }
}

thruput_erc165_if::impl_erc165!();
