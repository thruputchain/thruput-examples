//! Price-optimizing calculations, performed at request-handling time.
//!
//! In UniswapV2, these are run when a request is *made*; here they run when a request is *handled*,
//! against the reserves live at that moment.

use sdk::*;
use swap_if::{Amount, Amounts, SwapLibraryError, U256};

use SwapLibraryError::*;

/// Given an amount of token X, give a price quote for token Y
///
pub fn quote(amount_x: Amount, reserves: Amounts) -> Amount {
    const X: usize = 0;
    const Y: usize = 1;

    ensure(amount_x > 0, InsufficientAmount);
    ensure(reserves[0] > 0 && reserves[1] > 0, InsufficientLiquidity);

    let amount_y = (U256::from(amount_x) * U256::from(reserves[Y])) / U256::from(reserves[X]);

    amount_y.try_into().unwrap()
}

/// Given an input amount of token X, return the maximum output amount of token Y (accounting for a
/// .3% fee)
///
pub fn get_amount_out(amount_in: Amount, reserves: Amounts) -> Amount {
    const X: usize = 0;
    const Y: usize = 1;

    ensure(amount_in > 0, InsufficientInputAmount);
    ensure(reserves[X] > 0 && reserves[Y] > 0, InsufficientLiquidity);

    let amount_in_with_fee = U256::from(amount_in) * 997;
    let numerator = amount_in_with_fee * U256::from(reserves[Y]);
    let denominator = U256::from(reserves[X]) * 1000 + amount_in_with_fee;
    let amount_out: U256 = numerator / denominator;

    amount_out.try_into().unwrap()
}

/// Given a desired output amount of token Y, return the required input amount of token X
/// (accounting for a 0.3% fee)
///
pub fn get_amount_in(amount_out: Amount, reserves: Amounts) -> Amount {
    const X: usize = 0;
    const Y: usize = 1;

    ensure(amount_out > 0, InsufficientOutputAmount);
    ensure(reserves[X] > 0 && reserves[Y] > 0, InsufficientLiquidity);
    ensure(amount_out < reserves[Y], InsufficientLiquidity);

    let numerator = U256::from(reserves[X]) * U256::from(amount_out) * 1000;
    let denominator = U256::from(reserves[Y] - amount_out) * 997;
    let quotient: U256 = numerator / denominator;
    let amount_in: Amount = quotient.try_into().unwrap();

    amount_in.strict_add(1)
}
