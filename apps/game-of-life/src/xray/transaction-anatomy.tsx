import { cn } from "@/lib/utils";
import { formatCount, LIFE_WORKLOAD } from "./workload";

const STAGES = [
  {
    name: "Read required world state",
    work: "WorldState input",
    detail:
      "Load generation, bank, seed, population, digest, and queue limit. An uninitialized contract fails before queue consumption.",
    failure: "No canonical state changes.",
    input: "Stored WorldState or absence",
    output: "Required WorldState",
    authority: "Contract invocation",
  },
  {
    name: "Consume one queued request",
    work: "One request or no work",
    detail:
      "The crank consumes the next queued intent in transactional working state. An empty queue returns without advancing a generation.",
    failure:
      "The world remains at the same generation; any later failure restores a consumed request.",
    input: "Queue head",
    output: "Consumed request in transactional state",
    authority: "Contract queue storage",
  },
  {
    name: "Validate transition and stream the active bank",
    work: `${formatCount(LIFE_WORKLOAD.tickBankChunkReads)} canonical bank-chunk reads`,
    detail:
      "After queue consumption, check generation overflow and validate active_bank. Then seed a three-source-row toroidal window and stream the remaining rows.",
    failure:
      "Generation or bank validation failure restores the consumed request; later failures revert all invocation effects.",
    input: "Generation, active_bank, and canonical source chunks",
    output: "Next generation, inactive bank, and source-row stream",
    authority: "Contract invocation",
  },
  {
    name: "Evaluate and write each row",
    work: `${formatCount(LIFE_WORKLOAD.ruleEvaluations)} cells / ${formatCount(LIFE_WORKLOAD.tickBankChunkWrites)} writes`,
    detail:
      "For each row, evaluate every Conway cell, write both destination chunks to the inactive bank, and stream population and digest updates.",
    failure: "No partly written bank becomes canonical.",
    input: "Three source rows and one reusable output row",
    output: "Inactive-bank chunks, population, and digest",
    authority: "Contract invocation",
  },
  {
    name: "Switch metadata exclusively",
    work: "One serialized generation handoff",
    detail:
      "Set the next generation, internal active bank, population, and digest with the exclusive conflict that serializes world rewrites.",
    failure: "A conflict cannot expose mixed metadata and bank state.",
    input: "Next WorldState",
    output: "Exclusively staged metadata",
    authority: "Exclusive contract storage conflict",
  },
  {
    name: "Release capacity and emit evidence",
    work: "One slot / one GenerationAdvanced event",
    detail:
      "Release the consumed queue slot and emit request, requester, generation, population, and digest evidence.",
    failure: "The slot release and event revert with the invocation.",
    input: "Consumed request and complete result",
    output: "Released capacity and GenerationAdvanced",
    authority: "Contract invocation",
  },
  {
    name: "Include the complete transition",
    work: "Committed block or complete revert",
    detail:
      "The block contains the complete transaction outcome. External observers see the canonical state before or after the transition, never an intermediate bank.",
    failure:
      "A failed invocation leaves the request, banks, metadata, slot, and events unchanged.",
    input: "Complete transaction outcome",
    output: "Included post-state or unchanged pre-state",
    authority: "Groundhog transaction and block",
  },
] as const;

const EVIDENCE_TYPES = [
  {
    label: "Contract-derived",
    meaning: "Fixed by pinned constants, encoding, and algorithm.",
  },
  {
    label: "Chain metadata",
    meaning: "Returned by the current validated contract view.",
  },
  {
    label: "Indexer-attested provenance",
    meaning: "A validated indexer record of an event or metadata observation.",
  },
  {
    label: "Receipt-measured",
    meaning: "Decoded directly from a committed transaction receipt.",
  },
  {
    label: "Benchmark-measured",
    meaning: "Recorded with a versioned method and execution environment.",
  },
  {
    label: "Indexer-measured",
    meaning: "Observed while deriving verified visualization artifacts.",
  },
  {
    label: "Configured limit",
    meaning: "A supplied execution budget, never consumption.",
  },
  {
    label: "Illustrative",
    meaning: "Explanatory sequence or scale, never measured timing.",
  },
] as const;

export function TransactionAnatomy() {
  return (
    <>
      <section
        className="border-t border-border bg-canvas py-16 sm:py-20 lg:py-24"
        aria-labelledby="transaction-title"
      >
        <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3">
            <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
              ATOMIC TRANSACTION / PROCESS_NEXT_TICK
            </p>
            <h2
              id="transaction-title"
              className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
            >
              One invocation, one indivisible outcome
            </h2>
            <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
              The sequence below explains contract order and data flow. It is
              illustrative, not a live execution timeline or measured stage
              duration.
            </p>
          </div>

          <div className="mt-10 grid gap-8 lg:grid-cols-[2fr_5fr] lg:gap-12">
            <aside className="flex h-fit flex-col gap-4 border-l border-primary/40 pl-5 lg:sticky lg:top-24">
              <p className="font-mono text-base text-primary sm:text-sm">
                BEFORE THE CRANK
              </p>
              <h3 className="text-balance text-2xl font-semibold tracking-tight">
                Request and processing are separate transactions
              </h3>
              <p className="max-w-[42ch] text-pretty text-base text-muted-foreground sm:text-sm">
                A commuting{" "}
                <code className="font-mono text-foreground">
                  request_tick()
                </code>{" "}
                first inserts intent into the queue. A later permissionless{" "}
                <code className="font-mono text-foreground">
                  process_next_tick()
                </code>{" "}
                consumes one request and advances one generation.
              </p>
              <p className="max-w-[42ch] text-pretty text-base text-muted-foreground sm:text-sm">
                The caller who submits the crank does not necessarily own the
                request it processes. The event's request ID and requester
                establish attribution.
              </p>
            </aside>

            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-mono text-base sm:text-sm">
                <p className="text-primary">
                  TRANSACTION BOUNDARY / STAGES 01–06
                </p>
                <p className="text-muted-foreground">
                  ORDER / Contract-derived · LAYOUT / Illustrative
                </p>
              </div>
              <ol role="list" aria-label="Atomic tick stages">
                {STAGES.map((stage, index) => {
                  const insideTransaction = index < STAGES.length - 1;
                  return (
                    <li
                      key={stage.name}
                      className={cn(
                        "grid gap-3 p-5 sm:grid-cols-[4rem_2fr_3fr] sm:gap-5",
                        insideTransaction
                          ? "border-x border-t border-border bg-panel"
                          : "mt-6 rounded-lg border border-warning/40 bg-warning/5",
                        index === 0 && "rounded-t-lg",
                        index === STAGES.length - 2 && "rounded-b-lg border-b",
                      )}
                    >
                      <p className="font-mono text-lg text-warning tabular-nums">
                        {String(index + 1).padStart(2, "0")}
                      </p>
                      <div className="flex flex-col gap-2">
                        <h3 className="text-balance text-xl font-semibold">
                          {stage.name}
                        </h3>
                        <p className="font-mono text-base text-primary sm:text-sm">
                          {stage.work}
                        </p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <p className="max-w-[58ch] text-pretty text-base text-muted-foreground sm:text-sm">
                          {stage.detail}
                        </p>
                        <dl className="grid gap-x-4 gap-y-1 font-mono text-base sm:grid-cols-2 sm:text-sm">
                          <div>
                            <dt className="inline text-muted-foreground">
                              Input:{" "}
                            </dt>
                            <dd className="inline text-foreground">
                              {stage.input}
                            </dd>
                          </div>
                          <div>
                            <dt className="inline text-muted-foreground">
                              Output:{" "}
                            </dt>
                            <dd className="inline text-foreground">
                              {stage.output}
                            </dd>
                          </div>
                          <div>
                            <dt className="inline text-muted-foreground">
                              Authority:{" "}
                            </dt>
                            <dd className="inline text-foreground">
                              {stage.authority}
                            </dd>
                          </div>
                          <div>
                            <dt className="inline text-muted-foreground">
                              Source:{" "}
                            </dt>
                            <dd className="inline text-foreground">
                              Contract-derived
                            </dd>
                          </div>
                        </dl>
                        <p className="max-w-[58ch] text-pretty text-base text-foreground sm:text-sm">
                          <strong className="font-medium">Failure:</strong>{" "}
                          {stage.failure}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-5 max-w-[72ch] text-pretty text-base text-muted-foreground sm:text-sm">
                The row loop interleaves stages 03 and 04: it evaluates one
                destination row, writes that row, rotates source buffers, and
                reads the next source row. The grouping above explains the two
                responsibilities without claiming that all computation precedes
                all writes. The active bank remains immutable input throughout;
                writes target only the inactive bank.
              </p>
              <p className="mt-3 max-w-[72ch] text-pretty text-base text-muted-foreground sm:text-sm">
                The local demonstration treats a committed block as final under
                the frontend specification's compatibility assumption. X-Ray
                explains inclusion and commit; it does not independently prove
                network finality.
              </p>
            </div>
          </div>
        </div>
      </section>

      <ComputeLens />
    </>
  );
}

function ComputeLens() {
  return (
    <section
      className="border-t border-border py-16 sm:py-20 lg:py-24"
      aria-labelledby="compute-title"
    >
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
            COMPUTE LENS / FIXED WORKLOAD
          </p>
          <h2
            id="compute-title"
            className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
          >
            Count what the contract must do
          </h2>
          <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
            These counts describe canonical bank I/O and logical cell outcomes.
            Metadata, queue, map-key, event, and runtime operations are
            additional and are not hidden inside the chunk totals.
          </p>
        </div>

        <dl className="mt-10 grid border-y border-border md:grid-cols-2">
          <ComputeMetric
            label="Logical rule evaluations"
            value={formatCount(LIFE_WORKLOAD.ruleEvaluations)}
            detail="One outcome for every cell; not eight independent VM operations per cell."
            source="Contract-derived"
          />
          <ComputeMetric
            label="Canonical bank-chunk reads"
            value={formatCount(LIFE_WORKLOAD.tickBankChunkReads)}
            detail={`${formatCount(LIFE_WORKLOAD.tickBankReadBytes)} bytes including toroidal boundary rereads.`}
            source="Contract-derived"
          />
          <ComputeMetric
            label="Canonical bank-chunk writes"
            value={formatCount(LIFE_WORKLOAD.tickBankChunkWrites)}
            detail={`${formatCount(LIFE_WORKLOAD.tickBankWriteBytes)} bytes: one complete destination bank.`}
            source="Contract-derived"
          />
          <ComputeMetric
            label="Visible core row working set"
            value={`${formatCount(LIFE_WORKLOAD.visibleRowWorkingSetBytes)} bytes`}
            detail="Three source-row buffers plus one destination-row buffer; SDK temporaries may raise actual peak memory."
            source="Contract-derived"
          />
          <ComputeMetric
            label="Resulting population counts"
            value={formatCount(LIFE_WORKLOAD.resultingPopulationCounts)}
            detail="Accumulated while destination rows are produced."
            source="Contract-derived"
          />
          <ComputeMetric
            label="Streaming state digests"
            value={formatCount(LIFE_WORKLOAD.streamingDigests)}
            detail="Updated from every destination chunk in canonical key order."
            source="Contract-derived"
          />
        </dl>

        <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-12">
          <div className="flex flex-col gap-4 border-l border-primary/40 pl-5">
            <h3 className="text-balance text-2xl font-semibold tracking-tight">
              Why 20,004 reads, not 20,000?
            </h3>
            <div className="flex flex-col gap-2 font-mono text-base text-muted-foreground sm:text-sm">
              <p>
                Initial window = {LIFE_WORKLOAD.initialWindowRows} rows ×{" "}
                {LIFE_WORKLOAD.chunksPerRow} chunks ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(LIFE_WORKLOAD.initialBankChunkReads)} reads
                </strong>
              </p>
              <p>
                Stream = {formatCount(LIFE_WORKLOAD.worldHeight - 1)} rows ×{" "}
                {LIFE_WORKLOAD.chunksPerRow} chunks ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(LIFE_WORKLOAD.streamBankChunkReads)} reads
                </strong>
              </p>
              <p>
                Total = {formatCount(LIFE_WORKLOAD.initialBankChunkReads)} +{" "}
                {formatCount(LIFE_WORKLOAD.streamBankChunkReads)} ={" "}
                <strong className="font-medium text-warning">
                  {formatCount(LIFE_WORKLOAD.tickBankChunkReads)} reads
                </strong>
              </p>
              <p>
                Bytes = {formatCount(LIFE_WORKLOAD.worldHeight + 2)} row loads ×{" "}
                {formatCount(LIFE_WORKLOAD.rowBytes)} bytes ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(LIFE_WORKLOAD.tickBankReadBytes)} bytes
                </strong>
              </p>
              <p>
                Boundary rereads add{" "}
                <strong className="font-medium text-warning">
                  {formatCount(
                    LIFE_WORKLOAD.tickBankReadBytes - LIFE_WORKLOAD.bankBytes,
                  )}{" "}
                  bytes
                </strong>{" "}
                beyond one bank.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 border-l border-warning/40 pl-5">
            <p className="font-mono text-base text-warning sm:text-sm">
              RECEIPT MEASUREMENT NOT CONNECTED
            </p>
            <h3 className="text-balance text-2xl font-semibold tracking-tight">
              Execution measurements remain unavailable
            </h3>
            <p className="max-w-[48ch] text-pretty text-base text-muted-foreground sm:text-sm">
              X-Ray has no typed committed-receipt source for actual gas or
              execution duration. It does not infer consumption from configured
              gas limits or scrape benchmark prose.
            </p>
            <dl className="grid gap-2 font-mono text-base sm:text-sm">
              <div>
                <dt className="inline text-muted-foreground">Actual gas: </dt>
                <dd className="inline text-foreground">Not available</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">
                  Execution duration:{" "}
                </dt>
                <dd className="inline text-foreground">Not available</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">
                  Required source:{" "}
                </dt>
                <dd className="inline text-foreground">Receipt-measured</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="mt-14 border-t border-border pt-10">
          <h3 className="text-balance text-2xl font-semibold tracking-tight">
            Evidence labels
          </h3>
          <p className="max-w-[58ch] text-pretty text-base text-muted-foreground sm:text-sm">
            Every number and diagram uses one source label. Provenance kind is a
            separate property introduced with live evidence.
          </p>
          <dl className="mt-6 grid gap-x-10 md:grid-cols-2">
            {EVIDENCE_TYPES.map((type) => (
              <div key={type.label} className="border-t border-border py-4">
                <dt className="font-mono text-base font-medium text-foreground sm:text-sm">
                  {type.label}
                </dt>
                <dd className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
                  {type.meaning}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function ComputeMetric({
  label,
  value,
  detail,
  source,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly source: string;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border py-6 first:border-t-0 md:border-t-0 md:odd:pr-8 md:even:border-l md:even:pl-8 md:[&:nth-child(n+3)]:border-t">
      <dt className="font-mono text-base font-medium text-foreground sm:text-sm">
        {label}
      </dt>
      <dd className="font-mono text-3xl text-warning tabular-nums">{value}</dd>
      <dd className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
        {detail}
      </dd>
      <dd className="font-mono text-base text-primary sm:text-sm">
        Source / {source}
      </dd>
    </div>
  );
}
