import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { toHex0x } from "@groundhogchain/client";
import { configuration } from "@/test/fixtures";
import { TokensPage } from "./tokens-page";
import type { RegistryStatus } from "@/registry/client";

it("starts My Tokens on page one without the All Tokens snapshot", async () => {
  const config = configuration();
  const read = vi.fn().mockImplementation(async (_config, query) => ({
    tokens: [],
    total: 40,
    limit: 20,
    offset: query.offset,
    asOfBlock: "12",
    hasMore: true,
    historyLimited: false,
  }));
  const options = {
    config,
    readOnly: true,
    registryRead: read,
    registrySync: () => new Promise<RegistryStatus>(() => {}),
  };
  const { rerender } = render(
    <MemoryRouter>
      <TokensPage {...options} scope="all" />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(read.mock.lastCall?.[1]).toMatchObject({
      offset: 20,
      asOfBlock: "12",
    }),
  );
  rerender(
    <MemoryRouter>
      <TokensPage {...options} scope="mine" />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(read.mock.lastCall?.[1]).toEqual({
      creator: toHex0x(config.accountAddress),
      sort: "newest",
      offset: 0,
      limit: 20,
    }),
  );
});
