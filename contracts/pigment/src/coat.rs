//! A coat: one epoch's paint on one pixel, kept in a single integer that strokes add to.
//!
//! A coat is a weighted mix. It records how much paint it holds -- its depth -- and, for each
//! colour channel, the sum over its strokes of the stroke's amount times its value in that channel.
//! The mix's colour is each channel's sum over the depth. A stroke adds to all four sums and
//! changes nothing else, so the sums can be packed side by side in one integer, at fixed offsets,
//! and adding two packed integers adds every sum at once:
//!
//! ```text
//! bit 127     110       84        58        32         0
//!      | depth |  blue   |  green  |   red   |  epoch   |
//!      17 bits  26 bits   26 bits   26 bits   32 bits
//! ```
//!
//! That is what lets strokes on one pixel merge rather than conflict. Each stroke is an increment
//! to the coat's integer, and any number of transactions in a block can increment one key.
//!
//! Packing works only if no sum carries into the next. The depth is in the top lane of an `i128`,
//! so a depth above [`MAX_DEPTH`] would overflow the integer itself, and the storage layer refuses
//! that at commit, for the merged total of a block's strokes. Each colour sum is at most 255 times
//! the depth, which is below `2^25`, so it never fills its 26-bit lane. The runtime's own overflow
//! check therefore guards every lane.
//!
//! The low 32 bits hold the epoch the coat is from, and strokes never add to them. A coat from an
//! earlier epoch is stale, and the first stroke on it in a new epoch starts it over.

/// The most paint, in units, that a pixel holds from one epoch: the largest depth the top lane
/// holds without overflowing an `i128`.
pub const MAX_DEPTH: u32 = (1 << 17) - 1;

const LANE_BITS: u32 = 26;
const LANE: u128 = (1 << LANE_BITS) - 1;
const RED: u32 = 32;
const GREEN: u32 = RED + LANE_BITS;
const BLUE: u32 = GREEN + LANE_BITS;
const DEPTH: u32 = BLUE + LANE_BITS;

/// A coat, unpacked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Coat {
    /// The epoch the paint is from, modulo `2^32`.
    pub epoch: u32,

    /// Units of paint.
    pub depth: u32,

    /// For red, green and blue: the sum of each stroke's amount times its value in that channel.
    pub sums: [u32; 3],
}

impl Coat {
    /// An empty coat for `epoch`, packed. A slot is set to this when its pixel starts a new epoch.
    pub fn fresh(epoch: u64) -> i128 {
        i128::from(epoch as u32)
    }

    /// What a stroke of `amount` units of `color` (`0xRRGGBB`) adds to a packed coat.
    ///
    /// `amount` must be at most [`MAX_DEPTH`]; more does not fit the depth lane.
    pub fn stroke(color: u32, amount: u32) -> i128 {
        let amount = u128::from(amount);
        let channel = |shift: u32| u128::from((color >> shift) & 0xFF) * amount;
        ((amount << DEPTH) | (channel(0) << BLUE) | (channel(8) << GREEN) | (channel(16) << RED))
            as i128
    }

    pub fn unpack(packed: i128) -> Self {
        let packed = packed as u128;
        let lane = |shift: u32| ((packed >> shift) & LANE) as u32;
        Coat {
            epoch: packed as u32,
            depth: (packed >> DEPTH) as u32,
            sums: [lane(RED), lane(GREEN), lane(BLUE)],
        }
    }

    /// Whether this coat is from `epoch`. A slot is reused every other epoch, so a coat from any
    /// other epoch is stale.
    ///
    /// Epochs are compared modulo `2^32`: a slot untouched for exactly `2^32` epochs (over a
    /// century, at the shortest epoch a canvas allows) would be taken for current.
    pub fn is_from(&self, epoch: u64) -> bool {
        self.epoch == epoch as u32
    }
}

/// What a pixel shows, given its wet coat at full weight, and its fading coat at `left` parts in
/// `whole`. Returns the colour, as `0xRRGGBB`, and the alpha: how much of the paint has not yet
/// faded, from 0 (none, or no paint at all) to 255.
///
/// The colour is the mean of every stroke's, each weighted by its amount and by how much of it is
/// left. A blank pixel is black, with an alpha of 0.
pub fn mix(wet: &Coat, fading: &Coat, left: u64, whole: u64) -> (u32, u32) {
    let (left, whole) = (u128::from(left), u128::from(whole));
    // Under 2^17 units times a weight under 2^64, and lanes under 2^25 times one, so nothing here
    // comes near 2^128.
    let weigh = |wet: u32, fading: u32| u128::from(wet) * whole + u128::from(fading) * left;

    let depth = weigh(wet.depth, fading.depth);
    if depth == 0 {
        return (0, 0);
    }
    let color = (0..3).fold(0, |color, i| {
        // A weighted mean of values at most 255, so at most 255.
        (color << 8) | (weigh(wet.sums[i], fading.sums[i]) / depth) as u32
    });
    let unfaded = (u128::from(wet.depth) + u128::from(fading.depth)) * whole;
    (color, (depth * 255 / unfaded) as u32)
}
