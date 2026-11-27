//! The contract: keysets, ciphertexts, and gate evaluations that span transactions.
//!
//! * A **keyset** is one user's public evaluation key, and the funds that pay for its storage.
//!   Its owner creates it with a payment of native tokens, uploads its [`BSK_POLYS`]
//!   bootstrapping-key polynomials and [`KS_GROUPS`] groups of key-switching samples in any order
//!   over many transactions, and seals it.
//! * **Who pays.** On Thruput a contract pays the deposits for what it stores, and a caller
//!   cannot pay for the storage its call creates. So every keyset carries its own funds.
//!   `create_keyset` reserves the whole key's deposit, so uploads charge nothing; every other
//!   call that stores something under a keyset is its owner's and takes the deposit out of those
//!   funds ([`charge`](Fhe::charge)), failing with `Underfunded` before anything is stored when
//!   they run out. No account can spend what another account paid in.
//! * A **ciphertext** is an encrypted bit, stored under an id together with its keyset.
//!   [`put_ciphertext`](Fhe::put_ciphertext) stores one, [`not`](Fhe::not) and
//!   [`constant`](Fhe::constant) make one without any key, and a finished job makes one.
//!   Ciphertexts are public: anyone can read them, only the key holder can decrypt them.
//! * A **job** is one bootstrapped gate. [`start_gate`](Fhe::start_gate) combines the two
//!   inputs linearly; [`crank`](Fhe::crank), which anyone may call, runs as many blind-rotation
//!   steps as the transaction's gas allows, then the key switch, saving its progress between
//!   calls. The last crank stores the result and emits [`GateEvaluated`]. A job's storage is
//!   paid for when it starts, so cranking costs the cranker only gas.
//!
//! # Memory
//!
//! The guest has 64 KiB of data memory in all, stack included, and its allocator never frees. The
//! artifact is built with a 16 KiB stack (`--stack-size 16K`), because reading a 4 KiB storage
//! value goes through the stack twice; the NTT tables in `fhe-core` take 10.5 KiB; that leaves
//! 38 KiB of heap, about 4 KiB of it used before an entry point runs. A rotating crank allocates
//! 28 KiB (the accumulator and [`StepScratch`]); key switching runs on the stack. Key material is
//! read one storage value at a time, into the reading function's stack frame, and never held.

use alloc::boxed::Box;
use alloc::vec::Vec;
use fhe_core::bootstrap::{
    Accumulator, KeySource, KeySwitch, KsBig, KsGroup, Poly, StepScratch, blind_rotate_step,
    extract, init_accumulator,
};
use fhe_core::params::*;
use fhe_core::{Gate, Lwe, lwe};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::*;
use thruput_sdk::*;

/// Gas a crank keeps in hand before starting another blind-rotation step: the most a step costs
/// (24 cold reads of key polynomials and eight transforms) plus saving the accumulator, with a
/// margin. Measured on a node in `tests/testkit_gate.rs`.
pub const STEP_RESERVE: u64 = 4_000_000;
/// The same for one key-switching coefficient: up to five cold reads of sample groups, plus saving.
pub const SWITCH_RESERVE: u64 = 1_500_000;

#[contract_exception]
pub enum FheError {
    NotFound = 1,
    /// Only the keyset's owner may upload to it or seal it.
    NotOwner = 2,
    /// The keyset is sealed and can no longer change.
    Sealed = 3,
    /// The keyset is not sealed yet, so gates cannot be evaluated with it.
    NotSealed = 4,
    /// Upload data that is not whole polynomials or samples, or runs past the end of the key.
    InvalidUpload = 5,
    /// `seal` before every piece of the evaluation key is uploaded.
    Incomplete = 6,
    /// The two inputs of a gate belong to different keysets.
    KeysetMismatch = 7,
    InvalidGate = 8,
    /// Not a packed LWE ciphertext of [`LWE_BYTES`] bytes.
    InvalidCiphertext = 9,
    /// The job has finished.
    JobDone = 10,
    /// The keyset's funds cannot pay for the storage this call would create. Add funds with
    /// `fund_keyset`.
    Underfunded = 11,
    /// A gate's two inputs are the same ciphertext. Their noise would add coherently (`2e`
    /// rather than `e1 + e2`), well past the margin the parameters are chosen for.
    SameInput = 12,
    /// A bootstrapping-key value at or above the ring modulus.
    InvalidKey = 13,
    /// The transaction's gas cannot pay for even one step; send the crank with more gas.
    NotEnoughGas = 14,
    /// `initialize` has not set the network's storage rates yet.
    NotInitialized = 15,
    AlreadyInitialized = 16,
    /// `initialize` with a zero rate, or rates so large that a keyset's deposit overflows.
    InvalidRates = 17,
}

/// The network's deposit rates (see [`StorageRates`]), as the deployer read them from
/// `getChainConfig`.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rates {
    pub item: u128,
    pub byte: u128,
}

/// A user's evaluation key.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keyset {
    pub owner: ContractAddress,
    pub sealed: bool,
}

/// Where a job is.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Job {
    pub keyset: u64,
    /// The [`Gate`], as its index in [`Gate::ALL`].
    pub gate: u32,
    /// [`ROTATING`], [`SWITCHING`] or [`DONE`].
    pub stage: u32,
    /// The next LWE coefficient to rotate by, or the next ring coefficient to key-switch.
    pub next: u32,
    /// The result's ciphertext id, once [`DONE`].
    pub output: u64,
}

pub const ROTATING: u32 = 0;
pub const SWITCHING: u32 = 1;
pub const DONE: u32 = 2;

#[derive(Event, Clone, Debug)]
pub struct KeysetSealed {
    #[topic]
    pub keyset: u64,
}

#[derive(Event, Clone, Debug)]
pub struct GateStarted {
    #[topic]
    pub job: u64,
    #[topic]
    pub keyset: u64,
    pub gate: u32,
    pub x: u64,
    pub y: u64,
}

/// A job finished: `output` is the id of the result, whose packed ciphertext is included.
#[derive(Event, Clone, Debug)]
pub struct GateEvaluated<'a> {
    #[topic]
    pub job: u64,
    #[topic]
    pub output: u64,
    pub ciphertext: &'a [u8],
}

#[thruput_sdk::storage]
pub struct Fhe {
    rates: Value<Rates>,
    keyset_count: NNInt,
    keysets: Map<u64, Value<Keyset>>,
    // What each keyset may still spend on storage, in native-token base units. Its creator pays
    // it in; every call that stores something under the keyset takes the deposit out of it, so
    // no account can spend funds it did not provide.
    funds: Map<u64, Balance>,
    // Pieces of each evaluation key uploaded so far. Increments merge, so uploads of different
    // pieces can share a block.
    uploaded: Map<u64, NNInt>,
    // One polynomial (4,096 bytes) or one group of three samples (3,330 bytes) per storage value.
    bsk: Map<u64, Map<u32, Bytestring>>,
    ksk: Map<u64, Map<u32, Bytestring>>,

    ciphertext_count: NNInt,
    // Keyset id (8 bytes, little-endian), then the packed ciphertext.
    ciphertexts: Map<u64, Bytestring>,

    job_count: NNInt,
    jobs: Map<u64, Value<Job>>,
    // A job's working state: the combined input ciphertext while rotating, the accumulator's two
    // polynomials between rotation cranks, and the extracted ciphertext and partial key switch
    // between switching cranks. Deleted when the job finishes.
    job_input: Map<u64, Bytestring>,
    job_acc: Map<u64, Array<Bytestring, 2>>,
    job_big: Map<u64, Bytestring>,
    job_switch: Map<u64, Bytestring>,
}

/// The evaluation key of one keyset, read from storage on demand.
struct StoredKey<'a> {
    bsk: &'a Map<u32, Bytestring>,
    ksk: &'a Map<u32, Bytestring>,
}

impl KeySource for StoredKey<'_> {
    // Not inlined, so that the 4 KiB read buffer is on the stack only during the read.
    #[inline(never)]
    fn bsk_poly(&mut self, index: usize, f: impl FnOnce(&Poly)) {
        let bytes = Aligned(self.bsk.at(&(index as u32)).get_sized::<POLY_BYTES>());
        // Little-endian u32s, which is how RV32 (and the native test host) lays out a `Poly`.
        f(unsafe { &*(&bytes as *const Aligned<POLY_BYTES> as *const Poly) })
    }

    #[inline(never)]
    fn ks_group(&mut self, group: usize, f: impl FnOnce(&KsGroup)) {
        let bytes = Aligned(self.ksk.at(&(group as u32)).get_sized::<KS_GROUP_BYTES>());
        f(unsafe { &*(&bytes as *const Aligned<KS_GROUP_BYTES> as *const KsGroup) })
    }
}

/// Bytes read from storage, aligned so that they can be viewed as the `u32`s or `u16`s they
/// encode.
#[repr(C, align(4))]
struct Aligned<const N: usize>([u8; N]);

/// Read one polynomial: 1024 little-endian `u32`, which is how RV32 (and the native test host)
/// lays out a `Poly`.
///
/// Reading a 4 KiB value takes 8 KiB of stack (the SDK's `get_sized` holds two copies), so this
/// is never inlined: the frame exists only during the read, once on the call chain.
#[inline(never)]
fn read_poly(slot: &Bytestring, out: &mut Poly) {
    let bytes: [u8; POLY_BYTES] = slot.get_sized();
    *out = unsafe { core::mem::transmute::<[u8; POLY_BYTES], Poly>(bytes) };
}

/// Bytes of an extracted ciphertext: `RING_N + 1` little-endian `u16`.
const BIG_BYTES: usize = (RING_N + 1) * 2;

/// A counter's value; zero before its first write.
fn count(counter: &NNInt) -> u64 {
    counter.try_get().none_if_missing().unwrap_or(0) as u64
}

/// Little-endian `u16`s.
fn u16s(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| u16::from_le_bytes(*v))
}

/// A zero-initialized value on the heap, built in place: these buffers are larger than the stack.
fn zeroed<T>() -> Box<T> {
    // Safety: only used for arrays of integers, for which all-zero bytes are a valid value.
    unsafe {
        let layout = core::alloc::Layout::new::<T>();
        let ptr = alloc::alloc::alloc_zeroed(layout);
        if ptr.is_null() {
            alloc::alloc::handle_alloc_error(layout);
        }
        Box::from_raw(ptr as *mut T)
    }
}

impl Fhe {
    fn keyset(&self, id: u64) -> Keyset {
        self.keysets
            .at(&id)
            .try_get()
            .none_if_missing()
            .or_throw(FheError::NotFound)
    }

    fn owned_keyset(&self, id: u64) -> Keyset {
        let keyset = self.keyset(id);
        ensure(keyset.owner == get_caller(), FheError::NotOwner);
        keyset
    }

    fn rates(&self) -> StorageRates {
        let rates = self
            .rates
            .try_get()
            .none_if_missing()
            .or_throw(FheError::NotInitialized);
        StorageRates {
            item: rates.item,
            byte: rates.byte,
        }
    }

    /// Take `amount` out of a keyset's funds, or throw `Underfunded`. This reads the funds, so
    /// calls that charge one keyset are ordered; uploads charge nothing (`create_keyset`
    /// reserves the whole key), so they can share a block.
    fn charge(&mut self, keyset: u64, amount: u128) {
        self.funds
            .at_mut(&keyset)
            .try_decrease(amount as i128)
            .ok()
            .or_throw(FheError::Underfunded);
    }

    fn owned_open_keyset(&self, id: u64) -> Keyset {
        let keyset = self.keyset(id);
        ensure(keyset.owner == get_caller(), FheError::NotOwner);
        ensure(!keyset.sealed, FheError::Sealed);
        keyset
    }

    fn load_ciphertext(&self, id: u64) -> (u64, Lwe) {
        let slot = self.ciphertexts.at(&id);
        ensure(slot.exists(), FheError::NotFound);
        let bytes: [u8; 8 + LWE_BYTES] = slot.get_sized();
        let keyset = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        let ct = Lwe::from_bytes(&bytes[8..]).or_throw(FheError::InvalidCiphertext);
        (keyset, ct)
    }

    /// Store a ciphertext, paid for by the caller. The first one also creates the counter, which
    /// is charged to its keyset.
    fn store_ciphertext(&mut self, keyset: u64, ct: &Lwe) -> u64 {
        let id = count(&self.ciphertext_count);
        if id == 0 {
            let counter = self.rates().deposit(SMALL_VALUE_BYTES);
            self.charge(keyset, counter);
        }
        self.ciphertext_count.set(id as i128 + 1);
        let mut bytes = [0u8; 8 + LWE_BYTES];
        bytes[..8].copy_from_slice(&keyset.to_le_bytes());
        bytes[8..].copy_from_slice(&ct.to_bytes());
        self.ciphertexts.at_mut(&id).set(&bytes);
        id
    }

    /// Store `count` pieces of `size` bytes each from `data`, at `first` onwards, counting those
    /// not stored before.
    fn upload(
        &mut self,
        keyset: u64,
        ks: bool,
        first: u32,
        data: &[u8],
        size: usize,
        limit: usize,
    ) {
        self.owned_open_keyset(keyset);
        ensure(data.len().is_multiple_of(size), FheError::InvalidUpload);
        let count = data.len() / size;
        // In u64: on RV32 a usize sum could wrap past the limit.
        ensure(
            first as u64 + count as u64 <= limit as u64,
            FheError::InvalidUpload,
        );
        if !ks {
            // A key value at or above Q would make the step's lazy arithmetic overflow.
            let words = data.as_chunks::<4>().0;
            ensure(
                words.iter().all(|w| u32::from_le_bytes(*w) < RING_Q),
                FheError::InvalidKey,
            );
        }
        let mut added = 0;
        for (j, piece) in data.chunks_exact(size).enumerate() {
            let index = first + j as u32;
            let mut map = if ks {
                self.ksk.at_mut(&keyset)
            } else {
                self.bsk.at_mut(&keyset)
            };
            let mut slot = map.at_mut(&index);
            if !slot.exists() {
                added += 1;
            }
            slot.set(piece);
        }
        // The deposit for every piece was reserved by `create_keyset`.
        self.uploaded.at_mut(&keyset).inc(added);
    }
}

#[contract(throws = FheError, emits(KeysetSealed, GateStarted, GateEvaluated))]
impl Fhe {
    /// Create an empty keyset owned by the caller, paying `funds` native-token base units into
    /// it from the caller's balance. The caller must first allow this contract to spend them
    /// (`adjust_allowance` on the native token). The whole key's deposit
    /// ([`StorageRates::keyset`], about 83 native tokens) is reserved at once, so the funds must
    /// cover it; what is left pays for ciphertexts and gates.
    pub fn create_keyset(&mut self, funds: u128) -> u64 {
        let rates = self.rates();
        let owner = get_caller();
        ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
            &owner,
            &get_current_address(),
            funds as i128,
        );
        let id = count(&self.keyset_count);
        self.keyset_count.set(id as i128 + 1);
        self.keysets.at_mut(&id).set(&Keyset {
            owner,
            sealed: false,
        });
        self.funds.at_mut(&id).increase(funds as i128);
        // The first keyset also creates the keyset counter.
        let counter = if id == 0 {
            rates.deposit(SMALL_VALUE_BYTES)
        } else {
            0
        };
        self.charge(id, rates.keyset() + counter);
        id
    }

    /// Add funds to a keyset, from the caller's balance (on an allowance, as for
    /// `create_keyset`). Anyone may pay for anyone's keyset.
    pub fn fund_keyset(&mut self, keyset: u64, amount: u128) {
        self.keyset(keyset);
        ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
            &get_caller(),
            &get_current_address(),
            amount as i128,
        );
        self.funds.at_mut(&keyset).increase(amount as i128);
    }

    /// What a keyset may still spend on storage, in native-token base units.
    pub fn keyset_funds(&self, keyset: u64) -> u128 {
        self.funds.at(&keyset).get() as u128
    }

    /// Return `amount` of a keyset's unspent funds to its owner. Deposits already spent stay
    /// with the stored data: this example has no way to delete a keyset.
    pub fn withdraw(&mut self, keyset: u64, amount: u128) {
        let owner = self.owned_keyset(keyset).owner;
        self.charge(keyset, amount);
        ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&owner, amount as i128);
    }

    /// Upload consecutive bootstrapping-key polynomials ([`POLY_BYTES`] each), the first at index
    /// `first` (see [`fhe_core::params::bsk_index`]). Re-uploading a piece replaces it.
    pub fn upload_bsk(&mut self, keyset: u64, first: u32, polys: &[u8]) {
        self.upload(keyset, false, first, polys, POLY_BYTES, BSK_POLYS);
    }

    /// Upload consecutive groups of key-switching samples ([`KS_GROUP_BYTES`] each), the first
    /// at group `first` (samples `KS_GROUP * first ..`; see [`fhe_core::params::ks_index`]).
    pub fn upload_ksk(&mut self, keyset: u64, first: u32, groups: &[u8]) {
        self.upload(keyset, true, first, groups, KS_GROUP_BYTES, KS_GROUPS);
    }

    /// Pieces uploaded so far, out of `BSK_POLYS + KS_GROUPS`.
    pub fn uploaded(&self, keyset: u64) -> u64 {
        count(&self.uploaded.at(&keyset))
    }

    /// Freeze a complete keyset so that it can be computed with.
    pub fn seal(&mut self, keyset: u64) {
        let mut header = self.owned_open_keyset(keyset);
        ensure(
            self.uploaded(keyset) == (BSK_POLYS + KS_GROUPS) as u64,
            FheError::Incomplete,
        );
        header.sealed = true;
        self.keysets.at_mut(&keyset).set(&header);
        log_event(&KeysetSealed { keyset });
    }

    /// Record the network's deposit rates (`storageCosts.baseDataItemCost` and
    /// `bytestringCostPerByte` from `getChainConfig`), once, as part of deployment
    /// (`thruput deploy --init initialize --init-arg ITEM --init-arg BYTE`). Keysets are charged
    /// at these rates; were they lower than the network's, a keyset's funds would claim tokens
    /// that its storage had already spent, so clients check them against the chain.
    ///
    /// Anyone may call this until it succeeds, so deploy with `--init` to make it atomic. The
    /// rates are fixed for the life of the contract. Zero rates (storage recorded against no
    /// keyset) and rates whose keyset deposit overflows are refused.
    pub fn initialize(&mut self, item: u128, byte: u128) {
        ensure(self.rates.try_get().is_err(), FheError::AlreadyInitialized);
        let rates = StorageRates { item, byte };
        ensure(
            item > 0
                && byte > 0
                && rates
                    .checked_keyset()
                    .is_some_and(|keyset| keyset <= i128::MAX as u128),
            FheError::InvalidRates,
        );
        self.rates.set(&Rates { item, byte });
    }

    pub fn get_rates(&self) -> Rates {
        let r = self.rates();
        Rates {
            item: r.item,
            byte: r.byte,
        }
    }

    pub fn get_keyset(&self, keyset: u64) -> Keyset {
        self.keyset(keyset)
    }

    /// Store a ciphertext encrypted under `keyset`'s secret key; returns its id. Only the
    /// keyset's owner may store under it, since the keyset's funds pay the deposit; the same holds
    /// for `constant`, `not` and `start_gate`.
    pub fn put_ciphertext(&mut self, keyset: u64, ciphertext: &[u8]) -> u64 {
        self.owned_keyset(keyset);
        let ct = Lwe::from_bytes(ciphertext).or_throw(FheError::InvalidCiphertext);
        let cost = self.rates().ciphertext();
        self.charge(keyset, cost);
        self.store_ciphertext(keyset, &ct)
    }

    /// A noiseless encryption of a public bit.
    pub fn constant(&mut self, keyset: u64, bit: bool) -> u64 {
        self.owned_keyset(keyset);
        let cost = self.rates().ciphertext();
        self.charge(keyset, cost);
        self.store_ciphertext(keyset, &Lwe::constant(bit))
    }

    /// The keyset id (8 bytes, little-endian) and the packed ciphertext.
    pub fn get_ciphertext(&self, id: u64) -> Vec<u8> {
        let slot = self.ciphertexts.at(&id);
        ensure(slot.exists(), FheError::NotFound);
        let bytes: [u8; 8 + LWE_BYTES] = slot.get_sized();
        bytes.to_vec()
    }

    /// NOT needs no key and no bootstrap: the result is ready at once.
    pub fn not(&mut self, x: u64) -> u64 {
        let (keyset, ct) = self.load_ciphertext(x);
        self.owned_keyset(keyset);
        let cost = self.rates().ciphertext();
        self.charge(keyset, cost);
        self.store_ciphertext(keyset, &lwe::not(&ct))
    }

    /// Start evaluating `gate` ([`Gate`] by index: OR 0, AND 1, NOR 2, NAND 3, XOR 4, XNOR 5) on
    /// ciphertexts `x` and `y`. Returns the job id, to [`crank`](Self::crank).
    pub fn start_gate(&mut self, gate: u32, x: u64, y: u64) -> u64 {
        let g = Gate::from_index(gate).or_throw(FheError::InvalidGate);
        let (kx, cx) = self.load_ciphertext(x);
        let (ky, cy) = self.load_ciphertext(y);
        ensure(x != y, FheError::SameInput);
        ensure(kx == ky, FheError::KeysetMismatch);
        ensure(self.owned_keyset(kx).sealed, FheError::NotSealed);
        // Everything the job will store, paid now: anyone may crank, and cranks charge nothing.
        // The first job also creates the job counter.
        let rates = self.rates();
        let id = count(&self.job_count);
        let counter = if id == 0 {
            rates.deposit(SMALL_VALUE_BYTES)
        } else {
            0
        };
        self.charge(kx, rates.job() + counter);
        let combined = lwe::combine(g, &cx, &cy);
        self.job_count.set(id as i128 + 1);
        self.jobs.at_mut(&id).set(&Job {
            keyset: kx,
            gate,
            stage: ROTATING,
            next: 0,
            output: 0,
        });
        self.job_input.at_mut(&id).set(&combined.to_bytes());
        log_event(&GateStarted {
            job: id,
            keyset: kx,
            gate,
            x,
            y,
        });
        id
    }

    pub fn get_job(&self, job: u64) -> Job {
        self.jobs
            .at(&job)
            .try_get()
            .none_if_missing()
            .or_throw(FheError::NotFound)
    }

    /// Advance a job as far as this transaction's gas allows; anyone may call it. Returns the
    /// job's state afterwards. Each blind-rotation step starts only with [`STEP_RESERVE`] gas in
    /// hand, and each key-switching coefficient with [`SWITCH_RESERVE`].
    pub fn crank(&mut self, job: u64) -> Job {
        let mut state = self.get_job(job);
        ensure(state.stage != DONE, FheError::JobDone);
        let gate = Gate::from_index(state.gate).or_throw(FheError::InvalidGate);
        let before = (state.stage, state.next);
        if state.stage == ROTATING && !self.rotate(job, &mut state, gate) {
            ensure(state.next != before.1, FheError::NotEnoughGas);
            return state;
        }
        self.switch(job, &mut state);
        ensure((state.stage, state.next) != before, FheError::NotEnoughGas);
        state
    }
}

impl Fhe {
    /// Blind rotation, as far as gas allows. Returns whether it finished, in which case the
    /// extracted ciphertext is in `job_big` and the job is switching.
    ///
    /// The accumulator and step buffers (28 KiB) are on the heap, which the guest's bump
    /// allocator never frees; key switching therefore runs on the stack.
    #[inline(never)]
    fn rotate(&mut self, job: u64, state: &mut Job, gate: Gate) -> bool {
        let mut key = StoredKey {
            bsk: &self.bsk.at(&state.keyset),
            ksk: &self.ksk.at(&state.keyset),
        };
        let input: [u8; LWE_BYTES] = self.job_input.at(&job).get_sized();
        let input = Lwe::from_bytes(&input).or_throw(FheError::InvalidCiphertext);
        let mut acc: Box<Accumulator> = zeroed();
        if state.next == 0 {
            init_accumulator(&mut acc, gate, input.b as u32);
        } else {
            for (c, poly) in acc.iter_mut().enumerate() {
                read_poly(&self.job_acc.at(&job).at(c as u32), poly);
            }
        }
        let mut scratch: Box<StepScratch> = zeroed();
        while (state.next as usize) < LWE_N && stats::gas_remaining() > STEP_RESERVE {
            let i = state.next as usize;
            blind_rotate_step(&mut acc, &mut scratch, &mut key, i, input.a[i] as u32);
            state.next += 1;
        }
        if (state.next as usize) < LWE_N {
            for (c, poly) in acc.iter().enumerate() {
                let bytes = unsafe { core::mem::transmute::<&Poly, &[u8; POLY_BYTES]>(poly) };
                self.job_acc.at_mut(&job).at_mut(c as u32).set(bytes);
            }
            self.jobs.at_mut(&job).set(state);
            return false;
        }
        self.save_extracted(job, &acc);
        self.job_input.delete_at(&job);
        self.job_acc.delete_at(&job);
        state.stage = SWITCHING;
        state.next = 0;
        true
    }

    /// Extract the rotated accumulator's ciphertext into `job_big`. A function of its own, so that
    /// its 4 KiB of buffers are not on the stack during the rotation's reads.
    #[inline(never)]
    fn save_extracted(&mut self, job: u64, acc: &Accumulator) {
        let mut big = KsBig::new();
        extract(acc, &mut big);
        let mut bytes = [0u8; BIG_BYTES];
        for (b, v) in bytes
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .zip(big.a.iter().chain([&big.b]))
        {
            *b = v.to_le_bytes();
        }
        self.job_big.at_mut(&job).set(&bytes);
    }

    /// Key switching, as far as gas allows; stores the result when it finishes.
    #[inline(never)]
    fn switch(&mut self, job: u64, state: &mut Job) {
        let mut key = StoredKey {
            bsk: &self.bsk.at(&state.keyset),
            ksk: &self.ksk.at(&state.keyset),
        };
        // The extracted ciphertext (RING_N + 1 values mod KS_Q) and the partial sum.
        let big: [u8; BIG_BYTES] = self.job_big.at(&job).get_sized();
        let mut ks = KeySwitch::new();
        if state.next > 0 {
            let bytes: [u8; KS_SAMPLE_BYTES] = self.job_switch.at(&job).get_sized();
            for (j, v) in u16s(&bytes).enumerate() {
                if j < LWE_N { ks.a[j] = v } else { ks.b = v }
            }
        }
        let a = |i: usize| u16::from_le_bytes([big[2 * i], big[2 * i + 1]]);
        while (state.next as usize) < RING_N && stats::gas_remaining() > SWITCH_RESERVE {
            let i = state.next as usize;
            ks.absorb(&mut key, i, a(i));
            state.next += 1;
        }
        if (state.next as usize) < RING_N {
            let mut bytes = [0u8; KS_SAMPLE_BYTES];
            for (b, v) in bytes
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip(ks.a.iter().chain([&ks.b]))
            {
                *b = v.to_le_bytes();
            }
            self.job_switch.at_mut(&job).set(&bytes);
            self.jobs.at_mut(&job).set(state);
            return;
        }

        let out = ks.finish(a(RING_N));
        state.output = self.store_ciphertext(state.keyset, &out);
        state.stage = DONE;
        self.jobs.at_mut(&job).set(state);
        self.job_big.delete_at(&job);
        self.job_switch.delete_at(&job);
        // All of the job's working state is deleted now, which releases its deposit to the
        // contract; it goes back to the keyset that paid for it.
        let refund = self.rates().job_state();
        self.funds.at_mut(&state.keyset).increase(refund as i128);
        log_event(&GateEvaluated {
            job,
            output: state.output,
            ciphertext: &out.to_bytes(),
        });
    }
}
