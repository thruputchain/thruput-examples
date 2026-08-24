//! Only the handler may perform an operation that attributes its effects.
//!
//! `mint_lp`, `burn_lp` and `swap` each take the `sender` to credit and the
//! `RequestId` to stamp as arguments, neither of which the pair can check. If
//! anyone could call them, anyone could emit a `SwapEvent` bearing someone
//! else's request id and an arbitrary sender — and a client that correlates
//! execution by request id, as this application's does, would believe it.

mod common;
use common::*;

// Anyone who is not the handler is refused, whatever they name as the sender.
#[test]
fn attributed_operations_are_refused_from_anyone_else() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = &etx.ctx;

        for pretender in [ALICE, FACTORY, TEST] {
            let refused =
                etx.exec_user_tx(pretender, |u| ctx.pair().try_mint_lp(u.addr, u.addr, None))?;
            assert!(
                refused.is_err_and(|e| is_pair_error_and(e, |e| e == SwapPairError::Unauthorized)),
                "{} should not be able to mint",
                pretender.name
            );

            let refused =
                etx.exec_user_tx(pretender, |u| ctx.pair().try_burn_lp(u.addr, u.addr, None))?;
            assert!(
                refused.is_err_and(|e| is_pair_error_and(e, |e| e == SwapPairError::Unauthorized)),
                "{} should not be able to burn",
                pretender.name
            );

            let refused = etx.exec_user_tx(pretender, |u| {
                ctx.pair().try_swap(0, 0, u.addr, u.addr, None)
            })?;
            assert!(
                refused.is_err_and(|e| is_pair_error_and(e, |e| e == SwapPairError::Unauthorized)),
                "{} should not be able to swap",
                pretender.name
            );
        }

        Ok(())
    })
}

// Refusal comes before anything is read or written, so a rejected call cannot
// have half-performed the operation it was refused.
#[test]
fn a_refused_operation_leaves_the_pair_untouched() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = &etx.ctx;

        let before = etx.exec_user_tx(TEST, |_| ctx.pair().get_reserves())?;

        etx.exec_user_tx(ALICE, |u| ctx.pair().try_swap(1, 1, u.addr, u.addr, None))?
            .expect_err("refused");
        etx.advance_block();

        let after = etx.exec_user_tx(TEST, |_| ctx.pair().get_reserves())?;
        assert_eq!(before, after);

        Ok(())
    })
}

// `skim` and `sync` stay open to anyone, as in UniswapV2: they attribute
// nothing, and skim is how tokens sent to a pair by mistake are recovered.
#[test]
fn unattributed_operations_stay_open() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = &etx.ctx;

        etx.exec_user_tx(ALICE, |_| ctx.pair().sync())?;
        etx.advance_block();
        etx.exec_user_tx(ALICE, |u| ctx.pair().skim(u.addr))?;

        Ok(())
    })
}
