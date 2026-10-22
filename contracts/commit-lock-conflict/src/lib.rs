//! A minimal reproduction of commit-locked calls failing because of another
//! transaction in the same block, including one that is itself dropped.
//!
//! The contract is deployed twice. The *inner* instance holds one counter. The
//! *outer* instance's [`run`](Probe::run) writes the inner counter several
//! times, each write a call of its own, optionally made with
//! [`with_commit_locking`](ProbeClient::with_commit_locking), and reports which
//! calls succeeded.
//!
//! That is the shape of a batch crank (see `batch_driver`): a root frame
//! claiming the queue with an exclusive write, then making one commit-locked
//! call per request, each writing the same storage. A commit-locked call
//! acquires its two-phase-commit locks as soon as the callee frame finishes,
//! so that the caller sees a conflict as that call failing rather than the
//! whole transaction failing at commit.
//!
//! `tests/live.rs` puts `run` transactions into blocks on a local node and
//! prints what became of them; there, timing decides how two transactions'
//! calls interleave, so one case can come out several ways. `tests/mock.rs`
//! reproduces each of those ways in the mock harness, choosing the order
//! itself, and pins down the rule behind them.

#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::storage::Value;
use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

#[storage]
pub struct Probe {
    // Written by `bump` and `put` on the inner instance.
    counter: Value<u64>,

    // Written exclusively by `run` on the outer instance, when asked to claim.
    claims: Value<u64>,
}

#[contract]
impl Probe {
    /// Read the counter and write it back incremented.
    pub fn bump(&mut self) {
        let count = self.count();
        self.counter.set(&(count + 1));
    }

    /// Write the counter without reading it.
    pub fn put(&mut self, value: u64) {
        self.counter.set(&value);
    }

    /// The counter's value.
    pub fn count(&self) -> u64 {
        self.counter.try_get().none_if_missing().unwrap_or(0)
    }

    /// Write `target`'s counter `calls` times (at most 32), each in a call of
    /// its own, catching any failure.
    ///
    /// * `commit_locking`: make each call commit-locked.
    /// * `blind`: write with `put` rather than `bump`, so the callee writes
    ///   without reading.
    /// * `claim`: first make an exclusive write to this contract's own storage,
    ///   so two `run`s that both claim cannot both commit in one block.
    ///
    /// Returns two bitmasks, bit `i` describing call `i`: the calls that
    /// succeeded, and those that faulted. (A commit-locked call whose locks
    /// cannot be acquired faults.)
    pub fn run(
        &mut self,
        target: &ContractAddress,
        calls: u32,
        commit_locking: bool,
        blind: bool,
        claim: bool,
    ) -> (u32, u32) {
        if claim {
            let claims = self.claims.try_get().none_if_missing().unwrap_or(0);
            self.claims.set_exclusive(&(claims + 1));
        }

        let mut probe = ProbeClient::new(target);
        if commit_locking {
            probe = probe.with_commit_locking();
        }

        let (mut succeeded, mut faulted) = (0, 0);
        for i in 0..calls.min(32) {
            let result = if blind {
                probe.try_put(u64::from(i))
            } else {
                probe.try_bump()
            };
            match result {
                Ok(()) => succeeded |= 1 << i,
                Err(CallError::Fault(_)) => faulted |= 1 << i,
                Err(_) => {}
            }
        }
        (succeeded, faulted)
    }
}
