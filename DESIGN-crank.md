# swap application: cranking the request queue

## Background

* [groundhog architecture](~/groundhog/developers-site/src/content/docs/how-it-works/)
* [groundhog programming model](~/groundhog/developers-site/src/content/docs/programming-model/)
* In this repository: [swap application](~/groundhog/groundhog-examples/docs/README-swap.md)

_Note:_ The basic swap operations must occur serially, by design.  The suite of
swap contracts is designed to accept many requests for a particular swap pair
into a queue so that they can occasionally be processed in a batch, within one
block.  Without the queue, each request would have to be processed in its own
block, severely limiting the global swap "bandwith" (operations per block).

_Note:_ A particular entity does not likely have an interest in submitting
multiple requests against the same swap pair in the same block, as their effects
could instead be coalesced into one request.

## Current status

The swap contracts may be modified to suit our needs.

Requests submitted to the swap app (via the router -> driver) remain there until
someone invokes `SwapDriver::process_requests`, which processes *some number* of
the waiting requests. For short, we will call this "cranking the queue". The
driver contract may implement its own policy about whether to actually process
requests when the method is called, and how many; servicing many requests
requires a high gas-limit on the cranking transaction.

Submitting a request results in it being stored in a RCQ, incurring storage
costs. If the queue length is capped, the application administrator may be
willing to devote the fixed maximum of hogs required for that storage.

### Constraints and problems

* If the administrator of the swap instance is expected to crank the queue, then
  users must depend on the administrator to be live. Thus it seems that interested
  users must somehow participate in queue-cranking.
* In order to crank the queue, the submitted transaction must provide a
  gas-limit sufficient to process many requests. Currently this means that, in
  order to get the best latency by simultaneously scheduling the
  request-submission transaction *and* the queue-cranking transaction, a user
  would need sufficient free hogs for throughput to cover both.
* If a user were to combine request submission and queue cranking in one
  transaction, the high gas-limit required (approximately proportional to the
  maximum queue length enforced by the driver) could delay the request.
* If users always submit a crank transaction after each request submission, this
  may lead to many _degenerate cranks_ (calls to `process_requests` that result
  in no activity because the queue is empty or because the driver declines to do
  work on a below-threshold queue); furthermore (if the driver is more
  permissive), the queue may not ever build up sufficiently to allow many swap
  operations to occur within one block.

## Goals

We'd like to construct a scheme for cranking that:
- minimizes block-latency for each request (i.e., minimizes the number of blocks
  that pass before it is handled)
- maximizes block-bandwidth (i.e., maximizes the global number of swap
  operations that are handled in each block for a particular swap pair)

The scheme must also align incentives for the users of the application. For
example, if a user requires low latency, the scheme must allow them to somehow
stimulate queue-cranking with an acceptable free-hog encumbrance.  The
application administrator must not have to provide arbitrary amounts of HOG for
storage or throughput.

## Strawman proposal sketch

- The driver, when `process_requests` is called, proceeds to process a batch of
  requests if one of two conditions are met: (1) the queue length exceeds some
  threshhold QUEUE_RIPE_LEN, or (2) the blocks elapsed between the oldest queued
  request and the current block (the "age" of that oldest request) exceeds some
  threshhold REQUEST_RIPE_AGE.  If either condition is met, we will say that
  the queue is "ripe" for processing.
- Add to the `RequestSubmitted` event the current queue-length and
  oldest-request-age, so users can estimate when the next batch may occur.
- After submitting a request, a user MAY wait until it knows/suspects the queue is
  ripe (either by actively tracking the chain's block-height or by
  dead-reckoning with a known average inter-block time) and, if the request has
  not yet been processed, calls `process_requests`.  If the user is less
  latency-sensitive, they may wait for other users to crank.

This approach at least seems to bound the amount of time waited for request
servicing, and gives users some space to adopt their own policies.

