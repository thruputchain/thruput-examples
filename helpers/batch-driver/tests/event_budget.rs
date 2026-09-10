//! A maximal [`RequestFailed`] has to fit in an event.
//!
//! The protocol caps a serialized event at 1024 bytes, topics included, and
//! `log_event` *throws* on a longer one.  That throw would happen inside
//! [`batch_driver::Queue::crank`], where it aborts the batch -- losing the
//! requests that had already been handled successfully, not just the one being
//! reported.  So the ceiling is not a matter of truncating a bit more or less:
//! exceeding it turns a reported failure into a lost batch.
//!
//! [`EXCEPTION_PAYLOAD_MAX`] is what keeps that from happening, and this pins
//! it against the event that actually carries it.  A field added to
//! `RequestFailed` shrinks the room left for the payload, and this test is what
//! makes that show up here rather than in a batch.

use batch_driver::{Cause, EXCEPTION_PAYLOAD_MAX, RequestFailed};
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([7u8; 32]);

// The largest event the protocol will accept.
const EVENT_MAX: usize = 1024;

// Emit a `RequestFailed` carrying `n` payload bytes, and report the length of
// the event it serialized to (zero if it was refused).
fn emit(env: &TestEnvironmentHandle, n: usize) -> (bool, usize) {
    let r = env.transact(move |tx| {
        tx.call(&ADDR).run(move || {
            let id = SHA256Hash::new([1u8; 32]);
            let bytes = vec![0xABu8; n];
            log_event(&RequestFailed {
                request_id: &id,
                cause: Cause::Exception,
                selector: u64::MAX,
                payload: &bytes,
                payload_len: n as u32,
            });
        })
    });

    let len = r
        .events()
        .first()
        .map(|e| e.serialized_event.len())
        .unwrap_or(0);

    (r.frame().is_success(), len)
}

// A failure carrying the most payload the helper will ever put in one still
// fits, with room to spare.
#[test]
fn a_maximal_failure_event_fits() {
    let env = TestEnvironment::no_cost();

    let (ok, len) = emit(&env, EXCEPTION_PAYLOAD_MAX);
    assert!(ok, "a maximal RequestFailed must be loggable");
    assert!(
        len <= EVENT_MAX,
        "serialized to {len} bytes, over the {EVENT_MAX} cap"
    );
}

// ... and the room to spare is real: the payload could grow several times over
// before reaching the cap.  This is the margin that a field added to
// `RequestFailed` would eat into.
#[test]
fn the_ceiling_leaves_room_for_more_fields() {
    let env = TestEnvironment::no_cost();

    let (_, at_max) = emit(&env, EXCEPTION_PAYLOAD_MAX);
    let spare = EVENT_MAX - at_max;
    assert!(
        spare >= EXCEPTION_PAYLOAD_MAX,
        "only {spare} bytes spare beyond a maximal payload; either lower \
         EXCEPTION_PAYLOAD_MAX or accept that RequestFailed can take no more \
         fields"
    );
}

// The cap is a real edge, not a formality: past it the event is refused, and
// the frame that tried to log it aborts.
#[test]
fn an_oversized_event_is_refused() {
    let env = TestEnvironment::no_cost();

    let (ok, _) = emit(&env, EVENT_MAX);
    assert!(!ok, "an event past the cap must be refused, not truncated");
}
