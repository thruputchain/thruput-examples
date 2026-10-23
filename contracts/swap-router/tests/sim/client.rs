//! The shared core of the typed contract clients in this module.
//!
//! Each client (`ERC20Client`, `SwapRouterClient`, ...) is written by hand in the
//! shape `#[contract]` could generate from an interface trait: a [`Bound`]
//! contract plus one method per interface method. State-changing methods
//! return a [`ContractCall`] to await; read-only methods are simulated with
//! the client's caller as `msg.sender`.

use thruput_testkit::xdrs::{ReadXDR, WriteXDR};
use thruput_testkit::{Caller, Contract, ContractCall, Result};

use super::Address;

/// A contract bound to the caller its calls are submitted from.
#[derive(Debug, Clone)]
pub struct Bound {
    caller: Caller,
    contract: Contract,
}

impl Bound {
    pub fn new(caller: &(impl AsRef<Caller> + ?Sized), contract: Contract) -> Self {
        Self {
            caller: caller.as_ref().clone(),
            contract,
        }
    }

    pub fn address(&self) -> Address {
        self.contract.address()
    }

    pub fn call<R, A>(&self, method: &str, args: &A) -> ContractCall<R>
    where
        A: WriteXDR + ?Sized,
    {
        self.contract.prepare_call(&self.caller, method, args)
    }

    pub async fn view<R, A>(&self, method: &str, args: &A) -> Result<R>
    where
        A: WriteXDR + ?Sized,
        R: for<'r> ReadXDR<'r>,
    {
        let sender = Some(self.caller.address());
        self.contract.view(&self.caller, method, args, sender).await
    }
}
