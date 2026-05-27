mod common;
use common::*;

#[test]
fn check_sync() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        etx.exec_user_tx(FACTORY, |_| etx.ctx.factory_sync_skim_pair())
    });
}

#[test]
fn check_sync_wasm() {
    transact_assert_success(|| {
        let etx = setup_etx_wasm()?;
        etx.exec_user_tx(FACTORY, |_| etx.ctx.factory_sync_skim_pair())
    });
}
