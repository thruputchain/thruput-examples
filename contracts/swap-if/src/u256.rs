// `U256` comes from the SDK's `groundhog-u256`, whose representation is eight
// 32-bit limbs -- the width RV32 can actually divide with. See that crate for
// why that matters for contract code size.
pub use groundhog_u256::{U256, mul_div_u128};
