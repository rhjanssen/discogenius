import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpandableMetadataBlock } from "./ExpandableMetadataBlock";

afterEach(cleanup);

describe("ExpandableMetadataBlock", () => {
  it("keeps visually clipped links out of the tab order until expanded", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ExpandableMetadataBlock
        content={<><span>Short introduction. </span><a href="/hidden">Hidden detail</a></>}
        expanded={false}
        onToggle={onToggle}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Read more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Hidden detail" })).toBeNull();
    expect(screen.getByText("Short introduction. Hidden detail")).toBeVisible();

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <ExpandableMetadataBlock
        content={<><span>Short introduction. </span><a href="/hidden">Hidden detail</a></>}
        expanded
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Hidden detail" })).toHaveAttribute("href", "/hidden");
  });

  it("bounds the collapsed text exposed to assistive technology", () => {
    render(
      <ExpandableMetadataBlock
        content={"word ".repeat(200)}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const preview = screen.getByText(/word word/);
    expect(preview.textContent?.endsWith("…")).toBe(true);
    expect(preview.textContent?.length).toBeLessThanOrEqual(421);
  });
});
