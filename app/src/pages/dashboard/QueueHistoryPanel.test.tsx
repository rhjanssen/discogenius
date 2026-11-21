import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { QueueItemContract } from "@contracts/status";
import { ThemeProviderContext, type ThemeProviderState } from "@/providers/themeContext";
import { QueueHistoryPanel } from "./QueueHistoryPanel";
import { defaultQueueHistoryFilters } from "./queueHistoryFilters";

const LIGHT_THEME = {
  theme: "light",
  setTheme: () => undefined,
  isDarkMode: false,
  brandKeyColor: null,
  setBrandKeyColor: () => undefined,
} satisfies ThemeProviderState;

describe("QueueHistoryPanel", () => {
  it("retries a failed history row by its command id", () => {
    const onRetryItem = vi.fn();
    const failed: QueueItemContract = {
      id: 42288,
      url: null,
      type: "album",
      provider: "apple-music",
      providerId: "433171891",
      path: null,
      status: "failed",
      progress: 0,
      error: "Canonical audio tags were not applied for album 433171891: 1 file(s) missing",
      created_at: "2026-11-21T18:00:00Z",
      updated_at: "2026-11-21T18:08:00Z",
      completed_at: "2026-11-21T18:08:00Z",
      title: "Liverpool Rain",
      artist: "Racoon",
    };

    render(
      <FluentProvider theme={webLightTheme}>
        <ThemeProviderContext.Provider value={LIGHT_THEME}>
          <MemoryRouter>
            <QueueHistoryPanel
              items={[failed]}
              hasMore={false}
              isLoadingMore={false}
              onLoadMore={() => undefined}
              hasRefreshError={false}
              onRetryFeeds={() => undefined}
              onRetryItem={onRetryItem}
              filters={defaultQueueHistoryFilters}
              onFiltersChange={() => undefined}
            />
          </MemoryRouter>
        </ThemeProviderContext.Provider>
      </FluentProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry Liverpool Rain" }));
    expect(onRetryItem).toHaveBeenCalledWith(42288, "history");
  });
});
