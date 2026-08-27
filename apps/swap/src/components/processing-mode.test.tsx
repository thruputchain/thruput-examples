import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ProcessingModeProvider, useProcessingMode } from "./processing-mode";

describe("ProcessingModeProvider", () => {
  it("shares mode changes and resets with a fresh provider", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);

    expect(screen.getByTestId("mode")).toHaveTextContent("automatic");
    await user.click(screen.getByRole("button", { name: "Use manual mode" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("manual");
    await user.click(screen.getByRole("button", { name: "Replace consumer" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("manual");

    await user.click(screen.getByRole("button", { name: "Remount provider" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("automatic");
    view.unmount();
  });
});

function Harness() {
  const [key, setKey] = useState(0);
  const [consumer, setConsumer] = useState(0);
  return (
    <>
      <button onClick={() => setKey((current) => current + 1)}>
        Remount provider
      </button>
      <ProcessingModeProvider key={key}>
        <ModeControls key={consumer} />
        <button onClick={() => setConsumer((current) => current + 1)}>
          Replace consumer
        </button>
      </ProcessingModeProvider>
    </>
  );
}

function ModeControls() {
  const { mode, setMode } = useProcessingMode();
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode("manual")}>Use manual mode</button>
    </>
  );
}
