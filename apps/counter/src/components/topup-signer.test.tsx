// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AppHeader } from "./app-header";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "topup-toast"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the current balance, prevents duplicate clicks, and updates one toast on success", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(
    <AppHeader ready={false} canTopup signerBalance={0n} />,
  );
  const button = screen.getByRole("button", {
    name: "Top up Signer (curr 0 HOG)",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/topup",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  expect(toast.loading).toHaveBeenCalledWith("Requesting signer airdrop…");
  resolve(
    Response.json({ hash: `0x${"44".repeat(32)}`, rawAmount: "100000000" }),
  );
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Signer received 10 HOG.", {
      id: "topup-toast",
    }),
  );
  expect(button.disabled).toBe(false);
  rerender(<AppHeader ready canTopup signerBalance={100_000_000n} />);
  expect(
    screen.getByRole("button", { name: "Top up Signer (curr 10 HOG)" }),
  ).toBe(button);
});

it("uses an error toast and permits a new attempt", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Faucet cooldown. Try again later." },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ hash: `0x${"44".repeat(32)}`, rawAmount: "10000001" }),
      ),
  );
  render(<AppHeader ready canTopup signerBalance={189_986_486n} />);
  const button = screen.getByRole("button", {
    name: "Top up Signer (curr 18.998 HOG)",
  }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Faucet cooldown. Try again later.",
      { id: "topup-toast" },
    ),
  );
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Signer received 1.0000001 HOG.",
      { id: "topup-toast" },
    ),
  );
});

it("blocks top-up requests until configuration is available", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<AppHeader ready={false} canTopup={false} signerBalance={null} />);
  const button = screen.getByRole("button", {
    name: /^Top up Signer/,
  }) as HTMLButtonElement;
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});
