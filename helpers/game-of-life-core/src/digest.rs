use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"groundhog-life/world/v1";

pub struct WorldDigest {
    accumulator: [u8; 32],
}

impl WorldDigest {
    pub fn new(width: u32, height: u32, generation: u64) -> Self {
        let mut hash = Sha256::new();
        hash.update(DOMAIN);
        hash.update(width.to_be_bytes());
        hash.update(height.to_be_bytes());
        hash.update(generation.to_be_bytes());
        Self {
            accumulator: hash.finalize().into(),
        }
    }

    pub fn update(&mut self, chunk_key: u32, bytes: &[u8]) {
        let leaf: [u8; 32] = Sha256::digest(bytes).into();
        let mut hash = Sha256::new();
        hash.update(self.accumulator);
        hash.update(chunk_key.to_be_bytes());
        hash.update((bytes.len() as u32).to_be_bytes());
        hash.update(leaf);
        self.accumulator = hash.finalize().into();
    }

    pub const fn finish(self) -> [u8; 32] {
        self.accumulator
    }
}
