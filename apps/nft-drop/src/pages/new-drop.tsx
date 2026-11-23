import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useClient, useWallet } from "@thruputchain/react";
import {
  addressFromBase58,
  fixedBytes,
  formatUnits,
  toBase58,
  type ContractAddress,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { gasAmount, NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { useNavigate } from "react-router-dom";
import { Trash2Icon } from "lucide-react";
import { Artwork } from "../art/artwork";
import { percent, roll, share } from "../art/rarity";
import { STYLE_TRAITS } from "../art/style";
import { errorMessage, type AppConfig } from "../config";
import {
  CREATE_GAS,
  DEMO_DROP,
  LIMITS,
  NftDropFactory,
  validateDefinition,
  type DropDefinition,
} from "../contracts/drops";
import type { Transaction } from "../transactions/use-transaction";

interface Draft {
  name: string;
  symbol: string;
  supply: string;
  traits: { name: string; values: { name: string; weight: string }[] }[];
}

const template: Draft = {
  name: "",
  symbol: "",
  supply: "10000",
  traits: DEMO_DROP.traits.map((t) => ({
    name: t.name,
    values: t.values.map((v) => ({ name: v.name, weight: String(v.weight) })),
  })),
};

const whole = (text: string) =>
  /^\d+$/.test(text.trim()) ? BigInt(text.trim()) : -1n;

function toDefinition(draft: Draft): DropDefinition {
  return {
    name: draft.name,
    symbol: draft.symbol,
    supply: whole(draft.supply),
    traits: draft.traits.map((t) => ({
      name: t.name,
      values: t.values.map((v) => ({ name: v.name, weight: whole(v.weight) })),
    })),
  };
}

export function NewDrop({
  config,
  transaction: tx,
}: {
  config: AppConfig;
  transaction: Transaction;
}) {
  const client = useClient();
  const wallet = useWallet();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(template);
  const [samples, setSamples] = useState(0);
  const [created, setCreated] = useState<ContractAddress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definition = toDefinition(draft);
  const problem = validateDefinition(definition);
  // Samples need only valid traits: check them with the demo drop's other fields.
  const traitProblem = validateDefinition({
    ...DEMO_DROP,
    traits: definition.traits,
  });

  const funding = useQuery({
    queryKey: ["nft-drop", "funding", definition.supply.toString()],
    queryFn: () =>
      NftDropFactory.v0_1.requiredFunding.view({
        client,
        address: config.factory,
        args: { supply: definition.supply },
      }),
    enabled:
      definition.supply >= 1n && definition.supply <= BigInt(LIMITS.supply),
  });

  const preview = useMemo(
    () =>
      traitProblem
        ? []
        : Array.from({ length: 12 }, () => ({
            rolled: roll(definition.traits),
            seed: crypto.randomUUID(),
          })),
    [samples, JSON.stringify(draft.traits), traitProblem],
  );

  // Open the new drop once its creation commits.
  useEffect(() => {
    if (created && tx.completed?.label === "Create drop" && tx.completed.ok) {
      tx.dismiss();
      navigate(`/drops/${toBase58(created)}`);
    }
  }, [tx.completed, created]);

  async function create() {
    if (problem || !funding.data || !wallet.address) return;
    const creator = addressFromBase58(wallet.address);
    const nonce = fixedBytes(crypto.getRandomValues(new Uint8Array(32)), 32);
    setError(null);
    try {
      const { value: predicted } = await NftDropFactory.v0_1.predictDrop.view({
        client,
        address: config.factory,
        args: { creator, nonce },
      });
      setCreated(predicted);
      // One transaction: fund the new drop's address, then create the drop there.
      await tx.send(
        "Create drop",
        toBase58(predicted),
        [
          ERC20.v0_1.transfer.call({
            address: NATIVE_TOKEN_ADDRESS,
            gasLimit: gasAmount(1_000_000n),
            args: { receiver: predicted, amount: funding.data.value },
          }),
          NftDropFactory.v0_1.createDrop.call({
            address: config.factory,
            gasLimit: CREATE_GAS,
            args: { nonce, definition },
          }),
        ],
        gasAmount(25_000_000n),
      );
    } catch (error) {
      setCreated(null);
      setError(errorMessage(error));
    }
  }

  const update = (change: (next: Draft) => void) =>
    setDraft((current) => {
      const next: Draft = structuredClone(current);
      change(next);
      return next;
    });

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">New drop</p>
          <h1>Design a collection</h1>
          <p className="muted">
            Choose a supply and how often each trait value appears. Every trait
            changes the art, so you can reweight or remove traits and values,
            but not add them. Your wallet funds the drop's storage when it
            creates it.
          </p>
        </div>
      </div>
      <div className="create-layout">
        <form
          className="editor"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="field-row">
            <label>
              Name
              <input
                name="name"
                value={draft.name}
                placeholder="Thruput Grid"
                onChange={(e) => update((d) => void (d.name = e.target.value))}
              />
            </label>
            <label>
              Symbol
              <input
                name="symbol"
                value={draft.symbol}
                placeholder="GRID"
                onChange={(e) =>
                  update((d) => void (d.symbol = e.target.value))
                }
              />
            </label>
            <label>
              Supply
              <input
                name="supply"
                type="number"
                min={1}
                max={LIMITS.supply}
                value={draft.supply}
                onChange={(e) =>
                  update((d) => void (d.supply = e.target.value))
                }
              />
            </label>
          </div>
          {draft.traits.map((current, t) => {
            const shape = definition.traits[t]!;
            return (
              <fieldset key={current.name} className="trait-editor">
                <legend className="sr-only">{current.name}</legend>
                <div className="trait-heading">
                  <p>
                    <strong>{current.name}</strong>{" "}
                    <span className="muted">
                      {
                        STYLE_TRAITS.find(
                          (style) => style.name === current.name,
                        )?.description
                      }
                    </span>
                  </p>
                  <button
                    type="button"
                    className="small"
                    aria-label={`Remove trait ${current.name}`}
                    disabled={draft.traits.length <= 1}
                    onClick={() => update((d) => void d.traits.splice(t, 1))}
                  >
                    <Trash2Icon size={16} aria-hidden="true" />
                  </button>
                </div>
                <ul className="value-list">
                  {current.values.map((option, v) => (
                    <li key={option.name}>
                      <span className="value-name">{option.name}</span>
                      <input
                        className="weight"
                        type="number"
                        min={1}
                        max={LIMITS.weight}
                        value={option.weight}
                        aria-label={`${option.name} weight`}
                        onChange={(e) =>
                          update(
                            (d) =>
                              void (d.traits[t]!.values[v]!.weight =
                                e.target.value),
                          )
                        }
                      />
                      <span className="mono muted chance">
                        {percent(share(shape, v))}
                      </span>
                      <button
                        type="button"
                        className="small"
                        aria-label={`Remove ${option.name}`}
                        disabled={current.values.length <= 2}
                        onClick={() =>
                          update((d) => void d.traits[t]!.values.splice(v, 1))
                        }
                      >
                        <Trash2Icon size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
          <div className="panel">
            <p>
              Storage funding:{" "}
              <span className="mono">
                {funding.data
                  ? `${formatUnits(funding.data.value, 7)} native tokens`
                  : "–"}
              </span>
            </p>
            <p className="muted">
              The drop keeps this to pay for each token's storage. Request test
              tokens in your wallet if you need more.
            </p>
            {problem ? <p role="alert">{problem}</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {wallet.status !== "connected" ? (
              <p className="muted">Connect your wallet to create the drop.</p>
            ) : null}
            <div className="actions">
              <button
                type="submit"
                className="primary"
                disabled={
                  Boolean(problem) ||
                  !funding.data ||
                  wallet.status !== "connected" ||
                  tx.blocked
                }
              >
                Create drop
              </button>
            </div>
          </div>
        </form>
        <aside className="preview" aria-label="Sample tokens">
          <div className="section-heading">
            <h2>Samples</h2>
            <button
              type="button"
              className="small"
              onClick={() => setSamples((n) => n + 1)}
              disabled={Boolean(traitProblem)}
            >
              Reroll
            </button>
          </div>
          <p className="muted">
            Random rolls with your weights. Real mints roll on-chain.
          </p>
          <ul className="sample-grid">
            {preview.map(({ rolled, seed }) => (
              <li key={seed}>
                <Artwork
                  traits={definition.traits}
                  rolled={rolled}
                  seed={seed}
                  size={140}
                />
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}
