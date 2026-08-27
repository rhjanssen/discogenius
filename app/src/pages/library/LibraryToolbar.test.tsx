import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStatusFilters } from "@/utils/statusFilters";
import { LibraryToolbar, type LibraryToolbarProps } from "./LibraryToolbar";

afterEach(cleanup);

function toolbarProps(overrides: Partial<LibraryToolbarProps> = {}): LibraryToolbarProps {
  return {
    selectedTab: "artists",
    onSelectedTabChange: vi.fn(),
    onOpenImport: vi.fn(),
    isSelectionMode: false,
    onToggleSelectionMode: vi.fn(),
    sortBy: "name",
    sortDirection: "asc",
    onSortByChange: vi.fn(),
    onSortDirectionChange: vi.fn(),
    libraryFilter: "all",
    onLibraryFilterChange: vi.fn(),
    statusFilters: { ...defaultStatusFilters },
    onStatusFiltersChange: vi.fn(),
    showDownloadFilter: true,
    showLockFilter: true,
    canToggleView: true,
    viewMode: "grid",
    onViewModeChange: vi.fn(),
    ...overrides,
  };
}

describe("LibraryToolbar", () => {
  it("keeps all four category tabs available with a single mobile actions trigger", () => {
    render(<LibraryToolbar {...toolbarProps()} />);

    for (const label of ["Artists", "Albums", "Tracks", "Videos"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Library actions", hidden: true })).toBeInTheDocument();
  });

  it("puts selection, sorting, filtering, and view controls in the mobile actions menu", () => {
    render(<LibraryToolbar {...toolbarProps()} />);

    fireEvent.click(screen.getByRole("button", { name: "Library actions", hidden: true }));

    expect(screen.getByRole("menuitem", { name: "Select artists" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Switch to table view" })).toBeInTheDocument();
  });
});
