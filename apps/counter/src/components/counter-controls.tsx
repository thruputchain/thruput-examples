import { MinusIcon, PlusIcon } from "lucide-react";
import type { Direction } from "../transactions/engine";

export function CounterControls({
  disabled,
  value,
  send,
}: {
  disabled: boolean;
  value: bigint | null;
  send(direction: Direction): void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        type="button"
        className="counter-button border-border bg-secondary hover:bg-accent"
        disabled={disabled || value === 0n}
        onClick={() => send("decrement")}
      >
        <MinusIcon aria-hidden="true" className="size-6 shrink-0" /> Decrement
      </button>
      <button
        type="button"
        className="counter-button border-signal bg-signal text-primary-foreground hover:bg-primary-hover"
        disabled={disabled}
        onClick={() => send("increment")}
      >
        <PlusIcon aria-hidden="true" className="size-6 shrink-0" /> Increment
      </button>
    </div>
  );
}
