/// SplitMix64 with the canonical wrapping sequence used for generation zero.
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64 {
    state: u64,
    buffered: [u8; 8],
    buffered_at: usize,
}

impl SplitMix64 {
    pub const fn new(seed: u64) -> Self {
        Self {
            state: seed,
            buffered: [0; 8],
            buffered_at: 8,
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Fill a canonical byte stream without restarting at row or chunk boundaries.
    pub fn fill_bytes(&mut self, output: &mut [u8]) {
        for byte in output {
            if self.buffered_at == self.buffered.len() {
                self.buffered = self.next_u64().to_le_bytes();
                self.buffered_at = 0;
            }
            *byte = self.buffered[self.buffered_at];
            self.buffered_at += 1;
        }
    }
}
