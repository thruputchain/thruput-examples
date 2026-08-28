mod common;
use common::*;

#[test]
fn check_sync() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        {
            let ctx = etx.ctx;
            etx.exec_as_pair(move |pair| ctx.empty_pool_is_a_no_op(pair))
        }
    });
}
