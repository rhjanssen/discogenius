import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StockTabList } from "./StockTabList";

describe("StockTabList", () => {
  it("links stock tabs to their panels and reports selection", () => {
    const onSelect = vi.fn();
    render(
      <StockTabList
        idBase="library"
        ariaLabel="Library view"
        selectedValue="artists"
        onSelect={onSelect}
        items={[
          { key: "artists", label: "Artists", icon: <span aria-hidden="true">A</span> },
          { key: "albums", label: "Albums", icon: <span aria-hidden="true">B</span> },
        ]}
      />,
    );

    const albums = screen.getByRole("tab", { name: "Albums" });
    expect(albums).toHaveAttribute("id", "library-tab-albums");
    expect(albums).toHaveAttribute("aria-controls", "library-panel-albums");
    fireEvent.click(albums);
    expect(onSelect).toHaveBeenCalledWith("albums");
  });
});
