import axe from "axe-core";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProviderContext, type ThemeProviderState } from "@/providers/themeContext";
import { QualityBadge } from "./QualityBadge";

const LIGHT_THEME = {
  theme: "light",
  setTheme: () => undefined,
  isDarkMode: false,
  brandKeyColor: null,
  setBrandKeyColor: () => undefined,
} satisfies ThemeProviderState;

afterEach(cleanup);

function renderBadge(badge: React.ReactNode) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ThemeProviderContext.Provider value={LIGHT_THEME}>
        {badge}
      </ThemeProviderContext.Provider>
    </FluentProvider>,
  );
}

describe("QualityBadge accessibility", () => {
  it("exposes one named image when its tooltip is enabled", async () => {
    const { container } = renderBadge(<QualityBadge quality="LOSSLESS" />);

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "HIGH" })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("keeps a direct accessible name when a parent owns the tooltip", () => {
    renderBadge(<QualityBadge quality="DOLBY_ATMOS" showTooltip={false} />);

    expect(screen.getByRole("img", { name: "Dolby Atmos" })).toBeInTheDocument();
  });

  it("does not expose a badge for unknown quality", () => {
    const { container } = renderBadge(<QualityBadge quality="unknown" />);

    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
