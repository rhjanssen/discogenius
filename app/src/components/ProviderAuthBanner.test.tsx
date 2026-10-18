import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProviderAuthBanner } from "./ProviderAuthBanner";

afterEach(cleanup);

describe("ProviderAuthBanner", () => {
  it("announces the held count and a link to the provider field", () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <ProviderAuthBanner
          items={[{
            provider: "deezer",
            banner: "Deezer opnieuw koppelen",
            held: 3,
            href: "/auth?provider=deezer#deezer-arl",
            settingsLabel: "Naar Deezer-ARL",
          }]}
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Actie nodig");
    expect(alert).toHaveTextContent("Deezer opnieuw koppelen");
    expect(alert).toHaveTextContent("3 albums wachten");
    expect(screen.getByRole("link", { name: "Naar Deezer-ARL" })).toHaveAttribute(
      "href",
      "/auth?provider=deezer#deezer-arl",
    );

    fireEvent.click(screen.getByRole("button", { name: "Mislukte albums opnieuw proberen" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders nothing when every provider is usable", () => {
    render(
      <MemoryRouter>
        <ProviderAuthBanner items={[]} onRetry={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
