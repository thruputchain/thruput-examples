import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "@/config";
import {
  reviewFactory,
  type FactoryReview,
} from "@/contracts/launchpad-client";
import { userErrorMessage } from "@/errors";
import type { createReadClient } from "@/groundhog/client";
import { requestRegistrySync } from "@/registry/client";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { runWorkflow } from "./executor";
import { formatUnits, parseTokenDraft, type TokenDraft } from "./form";
import { actionLabel, canDiscardWorkflow } from "./presentation";
import {
  canDiscardInvalidStoredWorkflow,
  createWorkflow,
  loadWorkflow,
  saveWorkflow,
  withWorkflowLock,
  workflowIntent,
  workflowStorageKey,
  WorkflowStorageError,
  type LaunchWorkflow,
} from "./workflow";

const initialDraft: TokenDraft = {
  name: "",
  symbol: "",
  decimals: "7",
  supply: "1000000",
};

export interface LaunchOptions {
  config: AppConfig;
  client: ReturnType<typeof createReadClient>;
  writer: WriteBoundary;
  requestSync?: typeof requestRegistrySync;
  writesSupported?: boolean;
  connected?: boolean;
}

export function useLaunch({
  config,
  client,
  writer,
  requestSync = requestRegistrySync,
  writesSupported = true,
  connected = true,
}: LaunchOptions) {
  const storageKey = workflowStorageKey(config);
  const [initial] = useState(() => {
    try {
      return {
        workflow: loadWorkflow(localStorage, storageKey),
        error: null as string | null,
        invalidDiscardable: false,
      };
    } catch (error) {
      return {
        workflow: null,
        error: userErrorMessage(
          error,
          "The saved launch workflow could not be read",
        ),
        invalidDiscardable: canDiscardInvalidStoredWorkflow(
          localStorage,
          storageKey,
        ),
      };
    }
  });
  const [storageError, setStorageError] = useState(initial.error);
  const [workflow, setWorkflow] = useState<LaunchWorkflow | null>(
    initial.workflow,
  );
  const [draft, setDraft] = useState<TokenDraft>(() =>
    workflow
      ? {
          name: workflow.token.name,
          symbol: workflow.token.symbol,
          decimals: workflow.token.decimals.toString(),
          supply: formatUnits(
            BigInt(workflow.token.initialSupply),
            workflow.token.decimals,
          ),
        }
      : initialDraft,
  );
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<FactoryReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualProcessing, setManualProcessing] = useState(false);
  const generation = useRef(0);
  const working = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [client, config],
  );
  const parsed = parseTokenDraft(draft);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      working.current ||
      workflow ||
      storageError ||
      !writesSupported ||
      !connected
    )
      return;
    setSubmitted(true);
    setError(null);
    if (!parsed.value) return;
    const token = parsed.value;
    const attempt = ++generation.current;
    working.current = true;
    setLoading(true);
    try {
      const result = await withWorkflowLock(config, async () => {
        if (loadWorkflow(localStorage, storageKey))
          throw new Error(
            "Another tab created a launch workflow. Reload before continuing.",
          );
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const nextReview = await reviewFactory(client, config, nonce);
        if (attempt !== generation.current) return null;
        const nextWorkflow = createWorkflow(config, token, nonce, nextReview);
        saveWorkflow(localStorage, storageKey, nextWorkflow);
        return { nextReview, nextWorkflow };
      });
      if (result && attempt === generation.current) {
        setReview(result.nextReview);
        setWorkflow(result.nextWorkflow);
      }
    } catch (reason) {
      if (attempt === generation.current)
        setError(
          userErrorMessage(
            reason,
            "The configured token factory could not be verified.",
          ),
        );
    } finally {
      if (attempt === generation.current) {
        working.current = false;
        setLoading(false);
      }
    }
  }

  async function advance() {
    if (!workflow || working.current || !connected || !writesSupported) return;
    working.current = true;
    setLoading(true);
    setError(null);
    const attempt = generation.current;
    try {
      const next = await runWorkflow({
        config,
        client,
        writer,
        automatic: actionLabel(workflow, manualProcessing) === "Launch token",
        onUpdate: (next) => {
          if (attempt === generation.current) setWorkflow(next);
        },
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        expectedIntent: workflowIntent(workflow),
        ...(workflow.funding.status === "signing"
          ? { confirmUnsignedStep: "funding" as const }
          : workflow.creation.status === "signing"
            ? { confirmUnsignedStep: "creation" as const }
            : {}),
      });
      if (attempt !== generation.current) return;
      setReview(null);
      setWorkflow(next);
      if (
        workflow.creation.status !== "committed" &&
        next.creation.status === "committed"
      )
        void requestSync(config).catch(() => undefined);
    } catch (reason) {
      if (attempt === generation.current)
        setError(userErrorMessage(reason, "The launch could not continue."));
    } finally {
      if (attempt === generation.current) {
        working.current = false;
        setLoading(false);
      }
    }
  }

  async function reset(clearDraft = false) {
    if (working.current) return;
    if (workflow && !canDiscardWorkflow(workflow)) {
      setError("A workflow with transaction evidence cannot be discarded.");
      return;
    }
    working.current = true;
    setLoading(true);
    try {
      await withWorkflowLock(config, async () => {
        if (workflow === null) {
          try {
            if (loadWorkflow(localStorage, storageKey))
              throw new Error(
                "This launch changed in another tab. Reload before clearing it.",
              );
          } catch (reason) {
            if (!(reason instanceof WorkflowStorageError)) throw reason;
          }
          if (!canDiscardInvalidStoredWorkflow(localStorage, storageKey))
            throw new Error(
              "The invalid saved workflow may contain transaction evidence and cannot be discarded safely.",
            );
        } else {
          const stored = loadWorkflow(localStorage, storageKey);
          if (
            !stored ||
            stored.id !== workflow.id ||
            stored.revision !== workflow.revision
          )
            throw new Error(
              "This launch changed in another tab. Reload before clearing it.",
            );
        }
        localStorage.removeItem(storageKey);
      });
      setWorkflow(null);
      setReview(null);
      if (clearDraft || workflow?.creation.status === "committed")
        setDraft(initialDraft);
      setSubmitted(false);
      setError(null);
      setStorageError(null);
    } catch (reason) {
      setStorageError(
        userErrorMessage(
          reason,
          "The saved launch workflow could not be cleared.",
        ),
      );
    } finally {
      working.current = false;
      setLoading(false);
    }
  }

  return {
    draft,
    parsed,
    submitted,
    review,
    workflow,
    loading,
    error,
    storageError,
    invalidDiscardable: initial.invalidDiscardable,
    manualProcessing,
    setManualProcessing,
    submit,
    advance,
    reset: () => reset(),
    startOver: () => reset(true),
    edit(key: keyof TokenDraft, value: string) {
      if (working.current || workflow) return;
      setReview(null);
      setDraft((current) => ({ ...current, [key]: value }));
    },
  };
}
