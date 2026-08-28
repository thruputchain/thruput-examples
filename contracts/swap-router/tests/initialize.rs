mod common;
use common::*;

#[test]
fn initializing_twice_is_refused() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = etx.ctx;

        let refused = etx.exec_tx(&TEST_ADDR, move || {
            ctx.router().try_initialize(&ctx.request_handler_addr)
        })?;

        match refused {
            Err(SwapRouterClientError::SwapRouterError(SwapRouterError::AlreadyInitialized)) => {}
            other => panic!("expected AlreadyInitialized, got {other:?}"),
        }

        Ok(())
    })
}
