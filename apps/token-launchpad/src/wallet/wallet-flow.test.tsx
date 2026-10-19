import { toBase58 } from "@thruputchain/client";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppProviders } from "@/app-providers";
import { AppLayout } from "@/app-layout";
import { AppRoutes } from "@/routes";
import { configuration } from "@/test/fixtures";
import { testAccount, testClient, testWallet } from "@/test/wallet";

vi.mock("@/tokens/tokens-page", () => ({
  TokensPage: () => <input aria-label="Directory search" />,
}));
const config = configuration();
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  localStorage.clear();
});
async function setup() {
  const client = await testClient(config.networkId);
  const wallet = testWallet(config.networkId);
  cleanups.push(wallet.unregister);
  render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={["/tokens"]}>
        <AppLayout>
          <AppRoutes config={config} />
        </AppLayout>
      </MemoryRouter>
    </AppProviders>,
  );
  return { wallet, user: userEvent.setup() };
}

it("preserves public filters and disconnected launch drafts while isolating accounts", async () => {
  const { user, wallet } = await setup();
  await user.type(screen.getByLabelText("Directory search"), "acorn");
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.getByLabelText("Directory search")).toHaveValue("acorn");
  await user.click(screen.getByRole("link", { name: "Create Token" }));
  await user.type(screen.getByLabelText("Token name"), "Acorn");
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByLabelText("Token name")).toHaveValue("Acorn");
  expect(screen.getByRole("button", { name: "Review launch" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.getByLabelText("Token name")).toHaveValue("Acorn");
  await act(async () =>
    wallet.change({
      networkHash: config.networkId,
      accounts: [testAccount(2n)],
    }),
  );
  expect(screen.getByLabelText("Token name")).toHaveValue("");
});

it("handles popup cancellation quietly and makes wrong-network sessions read-only", async () => {
  const { user, wallet } = await setup();
  wallet.request.mockRejectedValueOnce(
    Object.assign(new Error("Page closed"), { code: 4001 }),
  );
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect Test Wallet" }));
  await act(async () =>
    wallet.change({
      networkHash: toBase58(new Uint8Array(32).fill(0xcd)),
      accounts: [testAccount()],
    }),
  );
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("network");
});
