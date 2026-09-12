// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CounterPage } from "./app";
import { initialSnapshot } from "./transactions/engine";

afterEach(cleanup);
const ready = { ...initialSnapshot, ready: true, value: 1_000_000n };

describe("counter controls", () => {
  it("allows repeated button submissions while earlier transactions are pending", () => {
    const send = vi.fn();
    render(
      <CounterPage
        config={null}
        snapshot={{ ...ready, pending: 10 }}
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrement" }));
    expect(send.mock.calls).toEqual([
      ["increment"],
      ["increment"],
      ["decrement"],
    ]);
    expect(screen.getByTestId("counter-value").textContent).toBe("1,000,000");
  });

  it("captures repeats but preserves shortcuts, Tab, modifiers, and composition", () => {
    const send = vi.fn();
    render(<CounterPage config={null} snapshot={ready} send={send} />);
    const pad = screen.getByRole("group", {
      name: "Keyboard transaction area",
    });
    fireEvent.keyDown(pad, { key: "a" });
    fireEvent.keyDown(pad, { key: "a", repeat: true });
    fireEvent.keyDown(pad, { key: "b", shiftKey: true });
    for (const key of ["Tab", "Shift", "Control", "Meta", "Escape"])
      fireEvent.keyDown(pad, { key });
    fireEvent.keyDown(pad, { key: "r", ctrlKey: true });
    fireEvent.keyDown(pad, { key: "r", metaKey: true });
    fireEvent.keyDown(pad, { key: "a", isComposing: true });
    expect(send).toHaveBeenCalledTimes(3);
    for (const [direction] of send.mock.calls)
      expect(["increment", "decrement"]).toContain(direction);
  });

  it("does not capture keys on the page or on buttons", () => {
    const send = vi.fn();
    render(<CounterPage config={null} snapshot={ready} send={send} />);
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Increment" }), {
      key: "Enter",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("ends capture on Escape and window blur", () => {
    render(<CounterPage config={null} snapshot={ready} send={vi.fn()} />);
    const pad = screen.getByRole("group", {
      name: "Keyboard transaction area",
    });
    fireEvent.click(pad);
    expect(pad.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(pad, { key: "Escape" });
    expect(pad.getAttribute("data-active")).toBe("false");
    fireEvent.click(pad);
    fireEvent(window, new Event("blur"));
    expect(pad.getAttribute("data-active")).toBe("false");
  });

  it.each([
    { ...ready, ready: false },
    { ...ready, atCapacity: true },
  ])("pauses controls when unavailable or at capacity", (snapshot) => {
    const send = vi.fn();
    render(<CounterPage config={null} snapshot={snapshot} send={send} />);
    const increment = screen.getByRole("button", {
      name: "Increment",
    }) as HTMLButtonElement;
    expect(increment.disabled).toBe(true);
    fireEvent.click(increment);
    fireEvent.keyDown(
      screen.getByRole("group", { name: "Keyboard transaction area" }),
      { key: "a" },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("disables manual decrement at zero", () => {
    render(
      <CounterPage
        config={null}
        snapshot={{ ...ready, value: 0n }}
        send={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Decrement" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
