//! What a driver's queue reports: one event as a request is accepted, one for each that fails, and
//! one summarizing the batch.

use thruput_sdk::*;

/// How much of a failed request's exception payload [`RequestFailed`] carries.
///
/// The protocol caps a whole serialized event at 1024 bytes, topics included, and an abort payload
/// at the same figure on its own -- so a verbatim copy cannot be guaranteed to fit, and an
/// oversized event *throws*, which inside a crank would abort the batch and lose the requests that
/// had already succeeded. The payload is therefore truncated, and this is the ceiling
/// [`RequestFailed::of`] truncates to.
///
/// [`RequestFailed::payload_len`] reports the untruncated length, so a reader can always tell when
/// there was more.
///
/// (`tests/event_budget.rs` checks that the cap is large enough for `RequestFailed` and small
/// enough to serialize.)
///
pub const EXCEPTION_PAYLOAD_MAX: usize = 256;

/// How a request's handling failed, for [`RequestFailed`].
///
/// A [`CallError`] has ten variants, but only one of them carries an exception. The rest still have
/// to be told apart, because they mean different things to whoever has to fix them: a fault is the
/// handler running out of the gas the request declared (or panicking); a rejection is a mis-wired
/// driver; a malformed result is interface skew between the two.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    /// The handler aborted with a selector-tagged error. This is the only cause for which
    /// [`RequestFailed`]'s `selector` and `payload` say anything.
    Exception = 1,

    /// The handler's frame died without a result: it exhausted the gas the request declared,
    /// panicked, or trapped. Nothing crosses a faulted call boundary, so there is nothing to report
    /// but the fact.
    Fault = 2,

    /// The call was refused before the handler ran at all -- no contract at the address, a
    /// reentrant call, or the invocation depth bound.
    Rejected = 3,

    /// The call completed but its result would not decode, on one side or the other.
    Malformed = 4,
}

/// Emitted by [`Queue::enqueue`] when a request is accepted, carrying the id it was stamped with.
///
/// [`Queue::enqueue`]: crate::Queue::enqueue
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestAccepted<'a> {
    #[topic]
    pub request_id: &'a SHA256Hash,
}

/// Emitted by [`Queue::crank`] for each request whose handling failed.
///
/// The payload is the exception's own wire bytes, truncated to [`EXCEPTION_PAYLOAD_MAX`] and
/// borrowed rather than copied.
///
/// [`Queue::crank`]: crate::Queue::crank
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestFailed<'a> {
    #[topic]
    pub request_id: &'a SHA256Hash,

    /// Which kind of failure this was, and so whether the two fields below mean anything.
    pub cause: Cause,

    /// The exception type's selector, or zero when `cause` is not [`Cause::Exception`].
    pub selector: u64,

    /// The leading bytes of the exception's payload, at most [`EXCEPTION_PAYLOAD_MAX`] of them.
    pub payload: &'a [u8],

    /// The payload's length before truncation, so a reader can tell that there was more than
    /// `payload` holds.
    pub payload_len: u32,
}

impl<'a> RequestFailed<'a> {
    /// Describe `e` as a failure of the request `request_id`, borrowing the exception's payload in
    /// place.
    pub fn of(request_id: &'a SHA256Hash, e: &'a CallError) -> Self {
        let (cause, selector, bytes): (Cause, u64, &'a [u8]) = match e {
            CallError::Exception(exn) => (Cause::Exception, exn.selector(), exn.payload()),
            CallError::Fault(_) => (Cause::Fault, 0, &[]),
            e if e.is_rejected_before_call() => (Cause::Rejected, 0, &[]),
            _ => (Cause::Malformed, 0, &[]),
        };

        Self {
            request_id,
            cause,
            selector,
            payload: &bytes[..bytes.len().min(EXCEPTION_PAYLOAD_MAX)],
            payload_len: bytes.len() as u32,
        }
    }
}

/// Emitted by [`Queue::crank`] once for a batch that processed anything.
///
/// A crank that found the queue empty emits nothing: it writes no delta and has nothing to report,
/// which is what keeps an unlucky crank free rather than a nuisance.
///
/// [`Queue::crank`]: crate::Queue::crank
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestsProcessed {
    /// How many requests left the queue, failures included.
    pub processed: u32,

    /// How many of those failed, each with its own [`RequestFailed`].
    pub failed: u32,
}
