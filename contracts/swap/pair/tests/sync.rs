mod common;
use common::*;

#[test]
fn check_sync() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = etx.ctx;
        etx.exec_as_pair(move |pair| ctx.empty_pair_is_a_no_op(pair))
    });
}

// An empty pair has nothing to mint against, and says so.
#[test]
fn minting_against_nothing_is_refused() {
    let etx = setup_etx().expect("setup");

    let r = etx
        .exec_as_pair(|pair| pair.mint_lp(&SOMEBODY))
        .expect_err("nothing deposited");

    assert_pair_error(&r, SwapPairError::InsufficientLiquidityMinted);
}
