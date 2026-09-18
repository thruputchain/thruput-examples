import { expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { render, screen } from "@/test/render";
import { AppLayout } from "./app-layout";

function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/pending")}>Next</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

it("keeps one shell through route changes and closes navigation on history changes", async () => {
  render(
    <MemoryRouter initialEntries={["/pools"]}>
      <AppLayout>
        <Navigation />
        <Routes>
          <Route path="/pools" element={<main>Pools content</main>} />
          <Route
            path="/pending"
            element={<main role="status">Loading pool</main>}
          />
        </Routes>
      </AppLayout>
    </MemoryRouter>,
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
  expect(screen.getByText("Loading pool")).toBeInTheDocument();
  expect(screen.getByRole("banner")).toBe(header);
  expect(screen.getByRole("region", { name: "Wallet connection" })).toBe(
    wallet,
  );
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("main")).toHaveTextContent("Pools content");
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  screen.getByRole("link", { name: "Pools" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
});
