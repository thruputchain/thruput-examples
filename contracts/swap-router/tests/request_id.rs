//! Lifecycle tracking: the request-id returned by a `SwapRouter` operation must
//! reappear on the event that operation eventually produces -- the pair's
//! `MintEvent`/`SwapEvent` on success, or the driver's `RequestFailed` on
//! failure -- so the off-chain application can correlate the two.

mod common;
use common::*;
use swap_pair::events::{MintEvent, SwapEvent};

// A swap demanding output >= input, impossible under the 0.3% fee: it enqueues
// but fails when handled.
const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

// The `request_id`s carried by the MintEvents emitted during a processed tx.
fn mint_request_ids(r: &TransactResult) -> Vec<Option<RequestId>> {
    let sig = MintEvent::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .map(|e| TypedEvent::<MintEvent>::new(e).payload().request_id)
        .collect()
}

// The `request_id`s carried by the RequestAccepted events emitted during a processed tx.
fn request_accepted_ids(r: &TransactResult) -> Vec<RequestId> {
    let sig = RequestAccepted::signature();
    r.events()
        .iter()
        .filter_map(|e| {
            let e = EmittedEvent::from(e);
            (e.topic(0) == sig).then(|| RequestId::new(*e.topic(1).expect("request_id topic")))
        })
        .collect()
}

// The request-ids carried by any RequestFailed events (the id is topic 1, a
// 32-byte value stored directly).
fn request_failed_ids(r: &TransactResult) -> Vec<RequestId> {
    let sig = RequestFailed::signature();
    r.events()
        .iter()
        .filter_map(|e| {
            let e = EmittedEvent::from(e);
            (e.topic(0) == sig).then(|| RequestId::new(*e.topic(1).expect("request_id topic")))
        })
        .collect()
}

fn count_events<E: Event>(r: &TransactResult) -> usize {
    let sig = E::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .count()
}

// Run `process_requests` as TEST_ADDR, returning the whole tx result (so its
// emitted events can be inspected) alongside the `(processed, failed)` counts.
fn process_capturing(etx: &Etx) -> (TransactResult, (u32, u32)) {
    etx.process_requests_capturing()
}

#[test]
fn add_liquidity_id_reaches_mint_event() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    // Establish reserves.
    etx.prime().expect("prime");

    // Alice provides liquidity through the router, capturing the returned id.
    let (amounts, _) = etx.user_balances(ALICE).expect("balances");
    etx.user_allow_for_pair(ALICE, amounts).expect("allow");
    etx.advance_block();

    let (id, r) = etx
        .exec_tx_result(ALICE.addr, || {
            let recipient = &get_current_address();
            ctx.router().add_liquidity(
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                amounts,
                [0, 0],
                recipient,
            )
        })
        .expect("add_liquidity");

    // The submission tx generated `RequestAccepted` for the returned id
    assert_eq!(request_accepted_ids(&r), vec![id]);

    // Processing the queued request produces exactly one MintEvent, carrying id.
    let (r, counts) = process_capturing(&etx);
    assert_eq!(counts, (1, 0), "one request processed, none failed");
    assert_eq!(mint_request_ids(&r), vec![Some(id)]);
}

#[test]
fn failed_request_emits_request_failed_with_id() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    etx.prime().expect("prime");

    etx.user_allow_for_pair(CAROL, [SWAP_IN_AMT, 0])
        .expect("allow");
    etx.advance_block();

    let id = etx
        .exec_user_tx(CAROL, |_| {
            let recipient = &get_current_address();
            ctx.router().swap_exact_tokens_for_tokens(
                SWAP_IN_AMT,
                SWAP_IN_AMT,
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                recipient,
            )
        })
        .expect("swap request enqueued");

    let (r, counts) = process_capturing(&etx);
    assert_eq!(counts, (1, 1), "one request processed, one failed");

    // The failure surfaces as a driver RequestFailed carrying the id...
    assert_eq!(request_failed_ids(&r), vec![id]);
    // ...and the pair's would-be SwapEvent was rolled back by commit-locking.
    assert_eq!(count_events::<SwapEvent>(&r), 0);

    // The event also says *why*, in the two pieces an off-chain observer needs:
    // the selector names the exception's type, and the payload's leading bytes
    // name the variant within it.  Both are decodable from the contract's spec
    // alone -- which is what this asserts, by reconstructing the answer the
    // way a client would.
    let failure = request_failures(&r).pop().expect("a RequestFailed");
    assert_eq!(failure.cause, Cause::Exception);
    assert_eq!(
        failure.selector,
        SwapRequestError::SELECTOR,
        "the handler's own error type"
    );
    assert_eq!(
        RawException::new(failure.selector, &failure.payload).try_as(),
        Some(SwapRequestError::InsufficientOutputAmount),
        "the swap asked for more out than the fee allows"
    );

    // Nothing was truncated, so the reported length matches what arrived.
    assert_eq!(failure.payload_len as usize, failure.payload.len());
}

// A `RequestFailed`'s payload, owned so it outlives the borrowed event.
struct Failure {
    cause: Cause,
    selector: u64,
    payload: Vec<u8>,
    payload_len: u32,
}

// The failures reported by any RequestFailed events in a processed tx.
fn request_failures(r: &TransactResult) -> Vec<Failure> {
    let sig = RequestFailed::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .map(|e| {
            let typed = TypedEvent::<RequestFailed>::new(e);
            let p = typed.payload();
            Failure {
                cause: p.cause,
                selector: p.selector,
                payload: p.payload.to_vec(),
                payload_len: p.payload_len,
            }
        })
        .collect()
}

#[test]
fn same_tx_requests_get_distinct_ids() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    etx.prime().expect("prime");
    etx.advance_block();

    // Two requests enqueued in ONE transaction (one root frame).  Both demand
    // output >= input, so both fail when handled -- but each must carry a
    // distinct id despite sharing a source-transaction hash.
    let (id1, id2) = etx
        .exec_user_tx(CAROL, |_| {
            let recipient = &get_current_address();
            let one = ctx.router().swap_exact_tokens_for_tokens(
                SWAP_IN_AMT,
                SWAP_IN_AMT,
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                recipient,
            );
            let two = ctx.router().swap_exact_tokens_for_tokens(
                SWAP_IN_AMT,
                SWAP_IN_AMT,
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                recipient,
            );
            (one, two)
        })
        .expect("enqueue two requests");

    assert_ne!(id1, id2, "same-tx requests must get distinct ids");

    let (r, counts) = process_capturing(&etx);
    assert_eq!(counts, (2, 2), "two requests processed, both failed");

    let failed = request_failed_ids(&r);
    assert_eq!(failed.len(), 2);
    assert!(failed.contains(&id1) && failed.contains(&id2));
}
