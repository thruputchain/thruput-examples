import type { ReactNode } from "react";
import type { ChainMetadata } from "@/chain/game-of-life";
import type { ReadAppConfig } from "@/config";
import type { ImmutableSnapshot } from "@/indexer/client";
import { cn } from "@/lib/utils";
import type {
  EvidenceSource,
  ReconciledEvidence,
  XrayEvidenceState,
} from "./evidence";
import { bankRolesForGeneration, formatCount } from "./workload";

export function EvidencePipeline({
  config,
  state,
  relationship,
  onRetry,
}: {
  readonly config: Readonly<ReadAppConfig>;
  readonly state: XrayEvidenceState;
  readonly relationship: ReconciledEvidence;
  readonly onRetry: () => void;
}) {
  const chain = state.chain.value;
  const snapshot = state.snapshot.value;
  const snapshotRejected =
    relationship.relationship === "integrity-conflict" && snapshot !== null;
  const snapshotSupportsHeadline =
    relationship.relationship === "aligned" ||
    relationship.relationship === "indexer-behind";
  const snapshotIsRetained = relationship.relationship === "snapshot-retained";
  return (
    <section
      className="border-t border-border bg-canvas py-16 sm:py-20 lg:py-24"
      aria-labelledby="evidence-title"
    >
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
            LIVE EVIDENCE / READ ONLY
          </p>
          <h2
            id="evidence-title"
            className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
          >
            Keep canonical and derived identities distinct
          </h2>
          <p className="max-w-[62ch] text-pretty text-lg text-muted-foreground sm:text-base">
            Chain metadata and the latest immutable indexer snapshot load
            independently. Agreement permits one joined explanation; lag or
            failure never blends their identities.
          </p>
        </div>

        <div
          className={cn(
            "mt-8 flex flex-col gap-3 border-l-2 py-1 pl-5",
            relationship.relationship === "aligned"
              ? "border-primary"
              : relationship.relationship === "integrity-conflict" ||
                  relationship.relationship === "incompatible"
                ? "border-destructive"
                : "border-warning",
          )}
          data-relationship={relationship.relationship}
        >
          <p className="font-mono text-base text-foreground sm:text-sm">
            RELATIONSHIP / {relationship.label}
          </p>
          <p className="max-w-[72ch] text-pretty text-base text-muted-foreground sm:text-sm">
            {relationship.detail}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 inline-flex h-12 w-fit items-center rounded-md border border-border px-4 text-base text-foreground outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
          >
            Refresh evidence
          </button>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <EvidenceCard
            title="Canonical chain metadata"
            source="Chain metadata"
            status={sourceStatus(state.chain)}
            error={state.chain.error}
          >
            <EvidenceFields
              fields={[
                ["Generation", count(chain?.generation, state.chain)],
                ["Population", count(chain?.population, state.chain)],
                [
                  "State digest",
                  chain?.stateDigest ?? unavailable(state.chain),
                ],
                ["Seed", count(chain?.seed, state.chain)],
                [
                  "World",
                  chain
                    ? `${formatCount(chain.width)} × ${formatCount(chain.height)}`
                    : unavailable(state.chain),
                ],
                [
                  "Queue capacity",
                  chain
                    ? formatCount(chain.maxQueueLength)
                    : unavailable(state.chain),
                ],
              ]}
            />
            <BankDerivation
              chain={chain}
              stale={state.chain.status === "stale"}
            />
          </EvidenceCard>

          <EvidenceCard
            title="Immutable visualization snapshot"
            source="Indexer-attested provenance"
            status={
              snapshotRejected
                ? "Rejected by eligibility check"
                : sourceStatus(state.snapshot)
            }
            error={state.snapshot.error}
          >
            {snapshotRejected ? (
              <>
                <p className="text-base text-muted-foreground sm:text-sm">
                  The indexed identity failed eligibility and is not used as
                  visualized or headline evidence.
                </p>
                <details className="mt-4 border-t border-border pt-4">
                  <summary className="cursor-pointer font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Rejected snapshot identity
                  </summary>
                  <EvidenceFields fields={snapshotFields(state.snapshot)} />
                </details>
              </>
            ) : (
              <EvidenceFields fields={snapshotFields(state.snapshot)} />
            )}
          </EvidenceCard>
        </div>

        <HeadlineEvidence
          config={config}
          snapshot={
            snapshotSupportsHeadline || snapshotIsRetained ? snapshot : null
          }
          retained={snapshotIsRetained}
          stale={relationship.stale}
        />
        <ProofZones />
      </div>
    </section>
  );
}

function EvidenceCard({
  title,
  source,
  status,
  error,
  children,
}: {
  readonly title: string;
  readonly source: string;
  readonly status: string;
  readonly error: string | null;
  readonly children: ReactNode;
}) {
  return (
    <article className="rounded-lg border border-border bg-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-base text-primary sm:text-sm">
            SOURCE / {source}
          </p>
          <h3 className="mt-1 text-balance text-2xl font-semibold tracking-tight">
            {title}
          </h3>
        </div>
        <p className="rounded-full border border-border px-3 py-1 font-mono text-sm text-muted-foreground">
          ● {status}
        </p>
      </div>
      <div className="mt-6">{children}</div>
      {error ? (
        <details className="mt-5 border-t border-border pt-4 text-base sm:text-sm">
          <summary className="cursor-pointer font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Technical source detail
          </summary>
          <p className="mt-2 break-words font-mono text-muted-foreground">
            {error}
          </p>
        </details>
      ) : null}
    </article>
  );
}

function EvidenceFields({
  fields,
}: {
  readonly fields: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <dl className="grid min-h-[16rem] content-start gap-x-6 sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <div key={label} className="border-t border-border py-3">
          <dt className="font-mono text-base text-muted-foreground sm:text-sm">
            {label}
          </dt>
          <dd className="mt-1 break-all font-mono text-base text-foreground sm:text-sm">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BankDerivation({
  chain,
  stale,
}: {
  readonly chain: ChainMetadata | null;
  readonly stale: boolean;
}) {
  if (!chain)
    return (
      <p className="mt-4 font-mono text-base text-muted-foreground sm:text-sm">
        Bank roles / Unknown until valid chain metadata arrives
      </p>
    );
  const roles = bankRolesForGeneration(BigInt(chain.generation));
  return (
    <div className="mt-4 border-l border-primary/40 pl-4">
      <p className="font-mono text-base text-foreground sm:text-sm">
        {stale ? "Last observed roles" : "Bank roles"} / Active {roles.active} ·
        Inactive {roles.inactive}
      </p>
      <p className="mt-1 text-base text-muted-foreground sm:text-sm">
        Contract-derived from generation parity, not returned directly by
        metadata.
      </p>
    </div>
  );
}

function HeadlineEvidence({
  config,
  snapshot,
  retained,
  stale,
}: {
  readonly config: Readonly<ReadAppConfig>;
  readonly snapshot: ImmutableSnapshot | null;
  readonly retained: boolean;
  readonly stale: boolean;
}) {
  const provenance = snapshot?.provenance;
  const sourceBlockLabel = !snapshot
    ? "Eligible snapshot source block"
    : retained
      ? "Retained indexed source block"
      : stale
        ? "Last observed eligible source block"
        : "Latest eligible source block";
  return (
    <div className="mt-12 border-y border-border py-8">
      <h3 className="text-balance text-2xl font-semibold tracking-tight">
        Inspectable claim bundle
      </h3>
      <dl className="mt-5 grid gap-x-10 md:grid-cols-2">
        <BundleField
          label="Configured network"
          value={config.networkId}
          source="Application configuration"
        />
        <BundleField
          label="Configured contract"
          value={config.contractAddress}
          source="Application configuration"
        />
        <BundleField
          label="Pinned source revision"
          value="51ec6b868d563b86dadc174956eb5ab5998cef6b / process_next_tick"
          href="https://github.com/groundhogchain/groundhog-examples/blob/51ec6b868d563b86dadc174956eb5ab5998cef6b/contracts/game-of-life/src/contract.rs"
          source="Repository revision"
        />
        <BundleField
          label="World layout"
          value="10,000 × 10,000 cells / row-major, one bit per cell, LSB-first"
          source="Contract-derived"
        />
        <BundleField
          label="Complete-bank I/O"
          value="20,004 reads / 12,502,500 bytes; 20,000 writes / 12,500,000 bytes"
          source="Contract-derived"
        />
        <BundleField
          label="Logical computation"
          value="100,000,000 rule evaluations; one population count; one streaming digest"
          source="Contract-derived"
        />
        <BundleField
          label="Atomic result"
          value="Exclusive metadata handoff and GenerationAdvanced; complete commit or complete revert"
          source="Contract-derived"
        />
        <BundleField
          label={sourceBlockLabel}
          value={provenance?.sourceBlockHeight ?? "Not available"}
          source="Indexer-attested provenance"
        />
        <BundleField
          label="Event-backed transaction"
          value={
            provenance?.transactionHash ??
            (provenance?.evidenceKind === "metadata-observation"
              ? "Not present / metadata-observation"
              : "Not available")
          }
          source="Indexer-attested provenance"
        />
        <BundleField
          label="Event provenance"
          value={eventProvenance(provenance)}
          source="Indexer-attested provenance"
        />
      </dl>
      <p className="mt-5 max-w-[82ch] text-pretty text-base text-muted-foreground sm:text-sm">
        X-Ray validates artifact schema, configured scope, identity agreement,
        and snapshot eligibility. It does not re-query and validate the
        historical event. Configuration identifies the deployment used by this
        app, but metadata does not cryptographically bind deployed bytecode to
        revision 51ec6b8.
      </p>
    </div>
  );
}

function BundleField({
  label,
  value,
  href,
  source,
}: {
  readonly label: string;
  readonly value: string;
  readonly href?: string;
  readonly source: string;
}) {
  const content = href ? (
    <a
      href={href}
      className="break-all underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {value}
    </a>
  ) : (
    value
  );
  return (
    <div className="border-t border-border py-3">
      <dt className="font-mono text-base text-muted-foreground sm:text-sm">
        {label}
      </dt>
      <dd className="mt-1 break-all font-mono text-base text-foreground sm:text-sm">
        {content}
      </dd>
      <dd className="mt-1 font-mono text-sm text-primary">Source / {source}</dd>
    </div>
  );
}

function ProofZones() {
  const zones = [
    {
      name: "Chain",
      source: "Canonical authority",
      items: [
        "Stores canonical bank chunks, metadata, and queue semantics.",
        "Serializes the complete generation rewrite through exclusive metadata update semantics.",
        "Computes population and digest while writing, emits GenerationAdvanced on success, and reverts invocation effects on failure.",
      ],
    },
    {
      name: "Indexer",
      source: "Derived artifact producer",
      items: [
        "Observes metadata and archival events, then downloads every canonical chunk for the generation.",
        "Recomputes the canonical digest and publishes immutable manifest and provenance before latest.json advances.",
        "Creates exact density and cell tiles; it never computes canonical next-state cells.",
      ],
    },
    {
      name: "Browser",
      source: "Validation and presentation",
      items: [
        "Validates schemas, configured scope, document agreement, and snapshot eligibility.",
        "Downloads only artifacts required by the current view; this page requests no tiles or canonical chunks.",
        "Displays source-qualified evidence. Canonical download verification exists; individual tile proofs do not.",
      ],
    },
  ] as const;
  return (
    <div className="mt-14">
      <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
        PROOF PIPELINE / AUTHORITY BOUNDARIES
      </p>
      <h3 className="mt-2 text-balance text-3xl font-semibold tracking-tight">
        Three zones, no transferred authority
      </h3>
      <ol
        className="mt-8 grid gap-5 lg:grid-cols-3"
        aria-label="Proof pipeline"
      >
        {zones.map((zone, index) => (
          <li key={zone.name} className="border-t border-primary/50 pt-5">
            <p className="font-mono text-base text-warning tabular-nums sm:text-sm">
              0{index + 1} / {zone.source}
            </p>
            <h4 className="mt-2 text-2xl font-semibold tracking-tight">
              {zone.name}
            </h4>
            <ul className="mt-4 flex list-disc flex-col gap-3 pl-5 text-base text-muted-foreground sm:text-sm">
              {zone.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function sourceStatus<T>(source: EvidenceSource<T>): string {
  switch (source.status) {
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "stale":
      return source.failure === "malformed"
        ? "Stale · malformed refresh rejected"
        : "Stale · unavailable refresh";
    case "unavailable":
      return "Unavailable";
    case "malformed":
      return "Malformed · rejected";
  }
}

function unavailable<T>(source: EvidenceSource<T>): string {
  return source.status === "loading" ? "Loading…" : "Not available";
}

function count<T>(
  value: string | undefined,
  source: EvidenceSource<T>,
): string {
  return value === undefined ? unavailable(source) : formatCount(BigInt(value));
}

function snapshotFields(
  source: EvidenceSource<ImmutableSnapshot>,
): ReadonlyArray<readonly [string, string]> {
  const snapshot = source.value;
  const provenance = snapshot?.provenance;
  return [
    ["Visualized generation", count(snapshot?.manifest.generation, source)],
    ["Population", count(snapshot?.manifest.population, source)],
    ["State digest", snapshot?.manifest.stateDigest ?? unavailable(source)],
    ["Source block height", count(provenance?.sourceBlockHeight, source)],
    ["Source block hash", provenance?.sourceBlockHash ?? unavailable(source)],
    ["Evidence kind", provenance?.evidenceKind ?? unavailable(source)],
    ["Event kind", provenance?.eventKind ?? "Not applicable"],
    [
      "Event index",
      provenance?.eventIndex === null || provenance?.eventIndex === undefined
        ? "Not applicable"
        : formatCount(provenance.eventIndex),
    ],
    [
      "Transaction hash",
      provenance
        ? (provenance.transactionHash ?? "Not present / metadata-observation")
        : unavailable(source),
    ],
    [
      "Request ID",
      provenance
        ? (provenance.requestId ?? "Not applicable")
        : unavailable(source),
    ],
    [
      "Requester",
      provenance
        ? (provenance.requester ?? "Not applicable")
        : unavailable(source),
    ],
    ["Verified at", provenance?.verifiedAt ?? unavailable(source)],
  ];
}

function eventProvenance(
  provenance: ImmutableSnapshot["provenance"] | undefined,
): string {
  if (!provenance) return "Not available";
  if (!provenance.eventKind)
    return `${provenance.evidenceKind} / no historical event asserted`;
  const request = provenance.requestId
    ? ` / request ${provenance.requestId} / requester ${provenance.requester}`
    : "";
  return `${provenance.eventKind} / event index ${provenance.eventIndex}${request}`;
}
