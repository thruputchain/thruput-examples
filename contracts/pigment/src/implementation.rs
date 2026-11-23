use crate::coat::{Coat, MAX_DEPTH, mix};
use alloc::vec::Vec;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::{Map, NNInt, Value};
use thruput_sdk::*;

/// The widest and tallest a canvas can be. It bounds what `initialize` lays out (two integers a
/// pixel) and what `row` reads.
pub const MAX_SIDE: u32 = 64;

/// The most strokes one `paint` can make.
pub const MAX_STROKES: u32 = 64;

/// The shortest an epoch can be: a second, in nanoseconds.
pub const MIN_EPOCH: u64 = 1_000_000_000;

/// The largest colour: white, every channel full.
const WHITE: u32 = 0xFF_FFFF;

/// What a canvas is, fixed when it is laid out.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    /// Pixels across, from 1 to [`MAX_SIDE`].
    pub width: u32,

    /// Pixels down, from 1 to [`MAX_SIDE`].
    pub height: u32,

    /// How long an epoch lasts, in nanoseconds: at least [`MIN_EPOCH`]. Paint is wet through the
    /// epoch it is applied in, and fades away through the next.
    pub epoch: u64,

    /// What a unit of paint costs, in native-token base units. Positive.
    pub price: i128,

    /// Who is paid for the paint, directly: the canvas keeps nothing.
    ///
    /// It should already hold native tokens. A native balance pays for its own storage, so a
    /// first payment too small to cover that cannot create one, and the paint it pays for cannot
    /// commit.
    pub beneficiary: ContractAddress,
}

/// A canvas's terms, and when it was laid out.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Canvas {
    pub terms: Terms,

    /// The timepoint epochs are counted from: the block that laid the canvas out, in Unix
    /// nanoseconds. Epoch `n` starts at `origin + n * terms.epoch`.
    pub origin: u64,
}

impl Canvas {
    // The epoch `now` falls in, and how far into it, in nanoseconds.
    fn epoch_at(&self, now: u64) -> (u64, u64) {
        let since = now.saturating_sub(self.origin);
        (since / self.terms.epoch, since % self.terms.epoch)
    }

    // Where pixel (x, y) is, counting along rows from the top left.
    fn index(&self, x: u32, y: u32) -> u32 {
        ensure(
            x < self.terms.width && y < self.terms.height,
            PigmentError::OffCanvas,
        );
        y * self.terms.width + x
    }
}

/// One stroke: `amount` units of `color` on pixel (`x`, `y`).
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stroke {
    pub x: u32,
    pub y: u32,

    /// `0xRRGGBB`.
    pub color: u32,

    /// Units of paint, at least 1. More covers more: a pixel's colour is the mean of its strokes',
    /// weighted by their amounts.
    pub amount: u32,
}

/// What one pixel shows, and the paint behind it.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pixel {
    /// The mix, as `0xRRGGBB`: the mean of every stroke's colour, weighted by its amount and by
    /// how much of it has not yet faded. Black on a blank pixel.
    pub color: u32,

    /// How much of the pixel's paint has not yet faded, from 0 (blank) to 255 (all of it wet).
    pub alpha: u32,

    /// Units applied this epoch, which are wet.
    pub wet: u32,

    /// Units applied last epoch, which are fading.
    pub fading: u32,
}

#[contract_exception]
pub enum PigmentError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The terms are not a canvas anyone could paint: see `initialize`.
    InvalidTerms = 3,
    /// A pixel outside the canvas.
    OffCanvas = 4,
    /// A colour above `0xFFFFFF`.
    InvalidColor = 5,
    /// No strokes, or a stroke of no paint.
    NoPaint = 6,
    /// The pixel already holds as much paint from this epoch as it can: [`MAX_DEPTH`] units.
    PixelFull = 7,
    /// A fee too large to represent.
    TooLarge = 8,
}

#[derive(Event, Clone, Debug)]
pub struct Painted {
    #[topic]
    pub painter: ContractAddress,
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub amount: u32,
}

/// A shared canvas whose strokes mix instead of conflicting.
///
/// Anyone may paint, at a price per unit of paint. A pixel shows the mean of the colours painted
/// on it, weighted by amount, so covering a colour takes more paint than it has. Paint is wet
/// through the epoch it is applied in, and fades away through the next; then it is gone.
///
/// A stroke reads nothing that another stroke writes in its block, and writes only an addition.
/// So any number of painters can paint one pixel in one block: their strokes all commit, and add
/// up to the same mix in whatever order the block holds them. On a chain that runs transactions
/// one at a time, a contested pixel goes to whoever is ordered last; here it goes to whoever puts
/// down the most paint.
///
/// Each pixel keeps two coats: one for even epochs and one for odd. Its coat for the current
/// epoch is wet, and its coat for the previous epoch is fading. When a new epoch begins, the coat
/// it reuses is two epochs old, and the first strokes on it start it over -- every one of them
/// writing the same fresh value, which is what lets them land together.
///
/// Every coat is laid out by `initialize`, and painting only rewrites them. So the canvas's
/// storage, and the deposits it holds, are fixed when it is laid out, however much it is painted.
#[thruput_sdk::storage]
pub struct Pigment {
    canvas: Value<Canvas>,

    // Two coats a pixel: pixel `p`'s coat for epoch `e` is at `2 * p + e % 2`. Each is a packed
    // `Coat`.
    coats: Map<u32, NNInt>,
}

impl Pigment {
    fn load(&self) -> Canvas {
        self.canvas
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(PigmentError::NotInitialized))
    }

    fn now() -> u64 {
        get_block_timepoint().into_inner()
    }

    fn valid(terms: &Terms) -> bool {
        (1..=MAX_SIDE).contains(&terms.width)
            && (1..=MAX_SIDE).contains(&terms.height)
            && terms.epoch >= MIN_EPOCH
            && terms.price > 0
            && terms.beneficiary != ContractAddress::default()
    }

    // Pixel `pixel`'s coat for `epoch`, unpacked, or an empty one if the slot holds an older
    // epoch's.
    fn coat(&self, pixel: u32, epoch: u64) -> Coat {
        let coat = Coat::unpack(self.coats.at(&slot(pixel, epoch)).get());
        if coat.is_from(epoch) {
            coat
        } else {
            Coat::default()
        }
    }

    // What pixel `pixel` shows `into` nanoseconds into `epoch`.
    fn show(&self, canvas: &Canvas, pixel: u32, (epoch, into): (u64, u64)) -> Pixel {
        let wet = self.coat(pixel, epoch);
        let fading = match epoch.checked_sub(1) {
            Some(last) => self.coat(pixel, last),
            None => Coat::default(),
        };
        // The fading coat has as much left as the epoch has left to run.
        let whole = canvas.terms.epoch;
        let (color, alpha) = mix(&wet, &fading, whole - into, whole);
        Pixel {
            color,
            alpha,
            wet: wet.depth,
            fading: fading.depth,
        }
    }
}

// Where pixel `pixel`'s coat for `epoch` is kept.
fn slot(pixel: u32, epoch: u64) -> u32 {
    2 * pixel + (epoch % 2) as u32
}

#[contract(throws(PigmentError, thruput_erc20_if::ERC20Error), emits(Painted))]
impl Pigment {
    /// Lay out a canvas: store its terms, and an empty coat for each slot. Call it in the
    /// transaction that deploys the contract.
    ///
    /// The terms must give a width and a height from 1 to [`MAX_SIDE`], an epoch of at least
    /// [`MIN_EPOCH`], a positive price, and a beneficiary.
    ///
    /// This creates all the storage the canvas will ever have, two integers a pixel, and the
    /// deposits for it come out of this contract's native tokens: send them to its address before
    /// deploying it, or earlier in the same transaction. A contract that cannot pay for them
    /// cannot commit this call.
    pub fn initialize(&mut self, terms: Terms) {
        ensure(
            self.canvas.try_get().none_if_missing().is_none(),
            PigmentError::AlreadyInitialized,
        );
        ensure(Self::valid(&terms), PigmentError::InvalidTerms);

        // Exclusive, so that of two `initialize` calls in one block, only one can commit.
        self.canvas.set_exclusive(&Canvas {
            terms,
            origin: Self::now(),
        });
        // Zero is an empty coat for epoch 0, which is where the canvas starts.
        for slot in 0..2 * terms.width * terms.height {
            self.coats.at_mut(&slot).set(0);
        }
    }

    /// Paint `strokes`, paying the beneficiary for every unit, in native tokens, on an allowance
    /// granted to this contract. Returns what was paid.
    ///
    /// Strokes may repeat a pixel. Each pixel holds at most [`MAX_DEPTH`] units from one epoch,
    /// counting this call's strokes and those of earlier blocks. Strokes from other transactions in
    /// this block cannot be seen here, so together they can ask a pixel for more than it holds.
    /// The runtime then admits those transactions while the pixel holds their paint, and leaves
    /// the rest out of the block, with nothing kept.
    pub fn paint(&mut self, strokes: VecM<Stroke, MAX_STROKES>) -> i128 {
        let canvas = self.load();
        ensure(!strokes.is_empty(), PigmentError::NoPaint);
        let (epoch, _) = canvas.epoch_at(Self::now());
        let painter = get_caller();

        let mut units: i128 = 0;
        for stroke in strokes.iter() {
            let pixel = canvas.index(stroke.x, stroke.y);
            ensure(stroke.color <= WHITE, PigmentError::InvalidColor);
            ensure(stroke.amount > 0, PigmentError::NoPaint);

            let mut slot = self.coats.at_mut(&slot(pixel, epoch));
            let mut held = Coat::unpack(slot.get());
            if !held.is_from(epoch) {
                // The slot holds paint from two epochs ago, or none. Every transaction painting
                // this pixel in this block reads the slot as of the block's start, finds the same,
                // and sets the same fresh coat. Identical sets of one key do not conflict, so they
                // all land, and their additions all count. A transaction in a later block finds
                // this epoch's coat, and only adds to it.
                slot.set(Coat::fresh(epoch));
                held = Coat::default();
            }
            ensure(
                u64::from(held.depth) + u64::from(stroke.amount) <= u64::from(MAX_DEPTH),
                PigmentError::PixelFull,
            );
            slot.inc(Coat::stroke(stroke.color, stroke.amount));

            units += i128::from(stroke.amount);
            log_event(&Painted {
                painter,
                x: stroke.x,
                y: stroke.y,
                color: stroke.color,
                amount: stroke.amount,
            });
        }

        let fee = units
            .checked_mul(canvas.terms.price)
            .unwrap_or_else(|| throw(PigmentError::TooLarge));
        ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
            &painter,
            &canvas.terms.beneficiary,
            fee,
        );
        fee
    }

    pub fn canvas(&self) -> Canvas {
        self.load()
    }

    /// What pixel (`x`, `y`) shows in this block, and the paint behind it.
    pub fn pixel(&self, x: u32, y: u32) -> Pixel {
        let canvas = self.load();
        self.show(&canvas, canvas.index(x, y), canvas.epoch_at(Self::now()))
    }

    /// What every pixel of row `y` shows in this block, left to right, each as `0xRRGGBBAA`: its
    /// colour, and its alpha in the low byte. At four bytes a pixel, the widest row fits in the
    /// 1,024 bytes a call may return.
    pub fn row(&self, y: u32) -> VecM<u32, MAX_SIDE> {
        let canvas = self.load();
        let start = canvas.index(0, y);
        let now = canvas.epoch_at(Self::now());
        VecM(
            (start..start + canvas.terms.width)
                .map(|pixel| {
                    let shown = self.show(&canvas, pixel, now);
                    (shown.color << 8) | shown.alpha
                })
                .collect::<Vec<_>>(),
        )
    }
}
