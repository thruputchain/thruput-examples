import { toBase58 } from "@thruputchain/client";
import { expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { testClient } from "@/test/wallet";
import { AppProviders } from "./app-providers";
import { AppLayout } from "./app-layout";

function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/prompt")}>Next</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

it("keeps one shell through route changes and closes navigation on history changes", async () => {
  const client = await testClient(toBase58(new Uint8Array(32).fill(0x00)));
  render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={["/tokens"]}>
        <AppLayout>
          <Navigation />
          <Routes>
            <Route path="/tokens" element={<main>Tokens content</main>} />
            <Route path="/prompt" element={<main>Connect your wallet</main>} />
          </Routes>
        </AppLayout>
      </MemoryRouter>
    </AppProviders>,
  );
  const user = userEvent.setup();
  const header = screen.getByRole("banner");
  const wallet = screen.getByRole("region", { name: "Wallet connection" });
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(
    screen.getByRole("button", { name: "Close navigation" }),
  ).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("main")).toHaveTextContent("Connect your wallet");
  expect(screen.getByRole("banner")).toBe(header);
  expect(screen.getByRole("region", { name: "Wallet connection" })).toBe(
    wallet,
  );
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("main")).toHaveTextContent("Tokens content");
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  screen.getByRole("link", { name: "Tokens" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
});
