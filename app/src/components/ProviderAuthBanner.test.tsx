import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ProviderAuthBanner, providerAuthWaitingText } from "./ProviderAuthBanner";

afterEach(cleanup);

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderBanner(onRetry = vi.fn(), retrying = false) {
  render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter initialEntries={["/"]}>
        <ProviderAuthBanner
          items={[{
            provider: "tidal",
            label: "Tidal",
            banner: "Sign in to Tidal again",
            held: 3,
            href: "/auth?provider=tidal#provider-connect-tidal",
          }]}
          onRetry={onRetry}
          retrying={retrying}
        />
        <Routes>
          <Route path="*" element={<CurrentLocation />} />
        </Routes>
      </MemoryRouter>
    </FluentProvider>,
  );
  return onRetry;
}

describe("ProviderAuthBanner", () => {
  it("shows the server title, what is waiting, and a reconnect link", () => {
    renderBanner();
    expect(screen.getByText("Sign in to Tidal again")).toBeInTheDocument();
    expect(screen.getByText(/3 albums are waiting for Tidal to reconnect\./)).toBeInTheDocument();
    const reconnect = screen.getByRole("link", { name: "Reconnect" });
    expect(reconnect).toHaveAttribute("href", "/auth?provider=tidal#provider-connect-tidal");
  });

  it("opens the reconnect flow inside the app", () => {
    renderBanner();
    fireEvent.click(screen.getByRole("link", { name: "Reconnect" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/auth?provider=tidal#provider-connect-tidal");
  });

  it("retries held albums and blocks double clicks while busy", () => {
    const onRetry = renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    cleanup();
    const busy = renderBanner(vi.fn(), true);
    fireEvent.click(screen.getByRole("button", { name: "Retrying…" }));
    expect(busy).not.toHaveBeenCalled();
  });

  it("words the waiting count for 0, 1 and many albums", () => {
    expect(providerAuthWaitingText("Tidal", 0)).toBe("Downloads via Tidal are waiting for Tidal to reconnect.");
    expect(providerAuthWaitingText("Tidal", 1)).toBe("1 album is waiting for Tidal to reconnect.");
    expect(providerAuthWaitingText("Tidal", 80534)).toBe("80,534 albums are waiting for Tidal to reconnect.");
  });

  it("renders nothing when every provider is usable", () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <MemoryRouter>
          <ProviderAuthBanner items={[]} onRetry={vi.fn()} />
        </MemoryRouter>
      </FluentProvider>,
    );
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });
});
