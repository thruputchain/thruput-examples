use thruput_erc20_if::ERC20Client;
use thruput_sdk::storage::{Map, Value};
use thruput_sdk::*;

#[contract_type]
#[derive(Clone, Debug)]
pub struct Reward {
    pub token: ContractAddress,
    pub amount: i128,
}

pub type Rewards = VecM<Reward, 16>;
pub type Addresses = VecM<ContractAddress, 256>;

#[contract_type]
#[derive(Clone, Debug)]
pub struct Configuration {
    pub rewards: Rewards,
    pub restricted: bool,
}

#[contract_exception]
pub enum AirdropError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidConfiguration = 3,
    NotEligible = 4,
    AlreadyClaimed = 5,
}

#[derive(Event, Clone, Debug)]
pub struct Claimed {
    #[topic]
    pub recipient: ContractAddress,
}

#[thruput_sdk::storage]
pub struct Airdrop {
    configuration: Value<Configuration>,
    allowed: Map<ContractAddress, Value<bool>>,
    claimed: Map<ContractAddress, Value<bool>>,
}

#[contract(throws = AirdropError, emits(Claimed))]
impl Airdrop {
    /// Initialize in the deployment transaction. An empty list opens eligibility.
    pub fn initialize(&mut self, rewards: Rewards, addresses: Addresses) {
        ensure(
            self.configuration.try_get().none_if_missing().is_none(),
            AirdropError::AlreadyInitialized,
        );
        ensure(!rewards.is_empty(), AirdropError::InvalidConfiguration);
        for (index, reward) in rewards.iter().enumerate() {
            ensure(reward.amount > 0, AirdropError::InvalidConfiguration);
            ensure(
                reward.token != ContractAddress::default() && reward.token != get_current_address(),
                AirdropError::InvalidConfiguration,
            );
            ensure(
                !rewards[..index]
                    .iter()
                    .any(|other| other.token == reward.token),
                AirdropError::InvalidConfiguration,
            );
        }
        for address in addresses.iter() {
            ensure(
                *address != ContractAddress::default(),
                AirdropError::InvalidConfiguration,
            );
            self.allowed.at_mut(address).set_exclusive(&true);
        }
        self.configuration.set_exclusive(&Configuration {
            rewards,
            restricted: !addresses.is_empty(),
        });
    }

    pub fn config(&self) -> Configuration {
        self.configuration
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(AirdropError::NotInitialized))
    }

    pub fn eligible(&self, address: &ContractAddress) -> bool {
        !self.config().restricted
            || self
                .allowed
                .at(address)
                .try_get()
                .none_if_missing()
                .unwrap_or(false)
    }

    pub fn has_claimed(&self, address: &ContractAddress) -> bool {
        self.claimed
            .at(address)
            .try_get()
            .none_if_missing()
            .unwrap_or(false)
    }

    /// Transfer every configured reward to the calling wallet, once per address.
    pub fn claim(&mut self) {
        let config = self.config();
        let recipient = get_caller();
        ensure(self.eligible(&recipient), AirdropError::NotEligible);
        ensure(!self.has_claimed(&recipient), AirdropError::AlreadyClaimed);
        // Exclusive per-address state prevents concurrent duplicate claims.
        // A failed child transfer rolls back this mark and every earlier transfer.
        self.claimed.at_mut(&recipient).set_exclusive(&true);
        for reward in config.rewards.iter() {
            ERC20Client::new(&reward.token).transfer(&recipient, reward.amount);
        }
        log_event(&Claimed { recipient });
    }
}
