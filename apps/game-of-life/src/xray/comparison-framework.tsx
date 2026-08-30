const QUESTIONS = [
  {
    boundary: "Admission",
    question:
      "Can one transaction admit the complete workload without splitting canonical responsibility across requests?",
  },
  {
    boundary: "Execution",
    question:
      "Can one invocation evaluate all 100,000,000 logical cell outcomes?",
  },
  {
    boundary: "State delta",
    question:
      "Can it read 12,502,500 canonical bytes and write 12,500,000 canonical bytes while retaining 100,000,000 persistent bits?",
  },
  {
    boundary: "Block production",
    question:
      "Can the complete result, metadata handoff, digest, and event be included atomically in one block?",
  },
  {
    boundary: "Finality",
    question:
      "What finality rule makes the post-state authoritative, and under which network assumptions?",
  },
  {
    boundary: "Data availability",
    question:
      "Can independent readers retrieve enough canonical state to reproduce the digest and derived view?",
  },
] as const;

export function ComparisonFramework() {
  return (
    <section
      className="border-t border-border py-16 sm:py-20 lg:py-24"
      aria-labelledby="comparison-title"
    >
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
          COMPARISON FRAMEWORK / REQUIREMENTS, NOT RANKINGS
        </p>
        <h2
          id="comparison-title"
          className="mt-3 max-w-[36ch] text-balance text-4xl font-semibold tracking-tight"
        >
          Ask the same atomic workload of every system
        </h2>
        <p className="mt-3 max-w-[68ch] text-pretty text-lg text-muted-foreground sm:text-base">
          Groundhog is represented here by this pinned implementation and the
          evidence shown above. Other systems need cited, reproducible
          measurements using the same workload and atomicity definition before
          receiving any pass, fail, cost, or performance judgment.
        </p>
        <ol
          className="mt-10 grid gap-x-10 md:grid-cols-2"
          aria-label="Workload comparison questions"
        >
          {QUESTIONS.map((item, index) => (
            <li key={item.boundary} className="border-t border-border py-6">
              <p className="font-mono text-base text-primary sm:text-sm">
                {String(index + 1).padStart(2, "0")} / {item.boundary}
              </p>
              <p className="mt-2 max-w-[48ch] text-pretty text-xl font-medium tracking-tight">
                {item.question}
              </p>
              <p className="mt-3 text-base text-muted-foreground sm:text-sm">
                Required support / versioned implementation, configured limits,
                receipt or benchmark measurements, and explicit assumptions as
                applicable.
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
