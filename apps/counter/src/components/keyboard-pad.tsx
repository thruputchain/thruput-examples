import { KeyboardIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Direction } from "../transactions/engine";

const RESERVED = new Set([
  "Tab",
  "Escape",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "Dead",
  "Unidentified",
]);

function isSmashKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "altKey" | "metaKey" | "nativeEvent"
  >,
): boolean {
  return (
    !RESERVED.has(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.nativeEvent.isComposing
  );
}

export function KeyboardPad({
  disabled,
  onInput,
}: {
  disabled: boolean;
  onInput(direction: Direction): void;
}) {
  const pad = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [pulse, setPulse] = useState<{
    id: number;
    direction: Direction;
  } | null>(null);
  useEffect(() => {
    const stop = () => {
      pad.current?.blur();
      setActive(false);
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <div
      ref={pad}
      role="group"
      aria-label="Keyboard transaction area"
      aria-describedby="keyboard-help"
      aria-disabled={disabled}
      tabIndex={0}
      data-active={active && !disabled}
      className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted p-6 text-center data-[active=true]:border-primary data-[active=true]:bg-accent"
      onClick={() => pad.current?.focus()}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.blur();
          return;
        }
        if (disabled || !isSmashKey(event)) return;
        event.preventDefault();
        const direction = Math.random() < 0.5 ? "increment" : "decrement";
        onInput(direction);
        setPulse((previous) => ({ id: (previous?.id ?? 0) + 1, direction }));
      }}
    >
      <div
        className="flex h-6 items-center justify-center gap-3 text-primary"
        aria-hidden="true"
      >
        <KeyboardIcon className="size-6 shrink-0" />
        {active && pulse ? (
          <div key={pulse.id} className="input-pulse font-mono">
            {pulse.direction === "increment" ? "+1" : "−1"}
          </div>
        ) : null}
      </div>
      <div className="font-mono text-base font-medium">
        {active ? "Smash those keys" : "Click here. Then smash your keys."}
      </div>
      <p
        id="keyboard-help"
        className="max-w-[56ch] text-base text-muted-foreground sm:text-sm"
      >
        {active
          ? "Each key sends a random +1 or −1. Hold a key to keep going. Esc to stop."
          : "One key. One transaction. No wallet prompts."}
      </p>
    </div>
  );
}
