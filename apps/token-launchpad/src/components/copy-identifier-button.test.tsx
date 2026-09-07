import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CopyIdentifierButton } from "./copy-identifier-button";

it.each([false, true])(
  "ignores an older copy result after the latest attempt settles (failure=%s)",
  async (failure) => {
    const user = userEvent.setup();
    let resolveFirst!: () => void;
    let rejectFirst!: (error: Error) => void;
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
      }),
    );
    if (failure) copy.mockRejectedValueOnce(new Error("denied"));
    else copy.mockResolvedValueOnce();
    render(<CopyIdentifierButton value="same" label="Copy identifier" />);
    try {
      const button = screen.getByRole("button", { name: "Copy identifier" });
      await user.click(button);
      await user.click(button);
      expect(button).toHaveAccessibleDescription(
        failure ? "Copy failed" : "Copied",
      );
      await act(async () => {
        if (failure) resolveFirst();
        else rejectFirst(new Error("older failure"));
      });
      expect(button).toHaveAccessibleDescription(
        failure ? "Copy failed" : "Copied",
      );
      expect(copy).toHaveBeenCalledTimes(2);
    } finally {
      copy.mockRestore();
    }
  },
);

it.each([false, true])(
  "resets accessible copy feedback when the value changes (failure=%s)",
  async (failure) => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    if (failure) copy.mockRejectedValue(new Error("denied"));
    else copy.mockResolvedValue();
    const { rerender } = render(
      <CopyIdentifierButton value="first" label="Copy identifier" />,
    );
    try {
      const button = screen.getByRole("button", { name: "Copy identifier" });
      await user.click(button);
      expect(button).toHaveAccessibleDescription(
        failure ? "Copy failed" : "Copied",
      );
      expect(copy).toHaveBeenCalledWith("first");
      rerender(<CopyIdentifierButton value="second" label="Copy identifier" />);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      rerender(<CopyIdentifierButton value="first" label="Copy identifier" />);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    } finally {
      copy.mockRestore();
    }
  },
);

it("does not show stale completion feedback for a different value", async () => {
  const user = userEvent.setup();
  let resolve!: () => void;
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const { rerender } = render(
    <CopyIdentifierButton value="first" label="Copy identifier" />,
  );
  try {
    await user.click(screen.getByRole("button"));
    rerender(<CopyIdentifierButton value="second" label="Copy identifier" />);
    await act(async () => resolve());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    copy.mockRestore();
  }
});
