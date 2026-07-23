import { createRoot, type Root } from "react-dom/client";
import { act, useState, type RefCallback } from "react";
import { MemoryRouter, Route, Routes, useNavigate, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHorizontalScrollRestore } from "./useHorizontalScrollRestore";

const STORAGE_KEY = "discogenius-horizontal-scroll";

/** happy-dom does not lay out flex overflow; force a scrollable strip. */
function makeScrollable(node: HTMLDivElement) {
  Object.defineProperty(node, "clientWidth", { configurable: true, get: () => 100 });
  Object.defineProperty(node, "scrollWidth", { configurable: true, get: () => 500 });
}

function useTestCarouselRef(storageKey: string): RefCallback<HTMLDivElement> {
  const restoreRef = useHorizontalScrollRestore(storageKey);
  return (node) => {
    if (node) makeScrollable(node);
    restoreRef(node);
  };
}

function CarouselPage({ storageKey }: { storageKey: string }) {
  const ref = useTestCarouselRef(storageKey);
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  return (
    <div>
      <span data-testid="nav-type">{navigationType}</span>
      <div
        data-testid="carousel"
        ref={ref}
        style={{ width: "100px", overflowX: "auto", display: "flex" }}
      >
        <div style={{ width: "500px", flexShrink: 0 }}>wide</div>
      </div>
      <button type="button" onClick={() => navigate("/detail")}>
        open
      </button>
    </div>
  );
}

function DetailPage() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

/** Mimics ArtistPage: hooks run during loading, carousel DOM appears later. */
function DeferredCarouselPage({ storageKey }: { storageKey: string }) {
  const ref = useTestCarouselRef(storageKey);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => setReady(true)}>
        show
      </button>
      {ready ? (
        <div
          data-testid="carousel"
          ref={ref}
          style={{ width: "100px", overflowX: "auto", display: "flex" }}
        >
          <div style={{ width: "500px", flexShrink: 0 }}>wide</div>
        </div>
      ) : null}
      <button type="button" onClick={() => navigate("/detail")}>
        open
      </button>
    </div>
  );
}

function mount(ui: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

describe("useHorizontalScrollRestore", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    // Clear after unmount so the detach save cannot re-seed storage.
    sessionStorage.removeItem(STORAGE_KEY);
  });

  it("saves scrollLeft after deferred carousel mount and restores on POP", async () => {
    ({ root, container } = mount(
      <MemoryRouter initialEntries={["/artist"]}>
        <Routes>
          <Route path="/artist" element={<DeferredCarouselPage storageKey="artist:deferred:albums" />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    ));

    expect(container!.querySelector('[data-testid="carousel"]')).toBeNull();

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    const carousel = container!.querySelector<HTMLDivElement>('[data-testid="carousel"]')!;

    await act(async () => {
      carousel.scrollLeft = 180;
      carousel.dispatchEvent(new Event("scroll"));
    });

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}")["artist:deferred:albums"]).toBe(180);

    await act(async () => {
      const buttons = [...container!.querySelectorAll("button")];
      buttons.find((b) => b.textContent === "open")!.click();
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    const restored = container!.querySelector<HTMLDivElement>('[data-testid="carousel"]')!;
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(restored.scrollLeft).toBe(180);
  });

  it("restores saved scrollLeft when returning via back navigation", async () => {
    ({ root, container } = mount(
      <MemoryRouter initialEntries={["/artist"]}>
        <Routes>
          <Route path="/artist" element={<CarouselPage storageKey="artist:immediate:albums" />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    ));

    const carousel = container!.querySelector<HTMLDivElement>('[data-testid="carousel"]')!;

    await act(async () => {
      carousel.scrollLeft = 220;
      carousel.dispatchEvent(new Event("scroll"));
    });

    await act(async () => {
      container!.querySelectorAll("button")[0].click();
    });

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    const restored = container!.querySelector<HTMLDivElement>('[data-testid="carousel"]')!;
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(container!.querySelector('[data-testid="nav-type"]')!.textContent).toBe("POP");
    expect(restored.scrollLeft).toBe(220);
  });

  it("merge-writes so a sibling carousel unmount cannot wipe another key", async () => {
    function DualCarouselPage() {
      const albumsRef = useTestCarouselRef("artist:merge:albums");
      const videosRef = useTestCarouselRef("artist:merge:videos");
      const navigate = useNavigate();
      return (
        <div>
          <div data-testid="albums" ref={albumsRef} style={{ width: "100px", overflowX: "auto", display: "flex" }}>
            <div style={{ width: "500px", flexShrink: 0 }}>albums</div>
          </div>
          <div data-testid="videos" ref={videosRef} style={{ width: "100px", overflowX: "auto", display: "flex" }}>
            <div style={{ width: "500px", flexShrink: 0 }}>videos</div>
          </div>
          <button type="button" onClick={() => navigate("/detail")}>open</button>
        </div>
      );
    }

    ({ root, container } = mount(
      <MemoryRouter initialEntries={["/artist"]}>
        <Routes>
          <Route path="/artist" element={<DualCarouselPage />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    ));

    const albums = container!.querySelector<HTMLDivElement>('[data-testid="albums"]')!;
    await act(async () => {
      albums.scrollLeft = 320;
      albums.dispatchEvent(new Event("scroll"));
    });

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}")["artist:merge:albums"]).toBe(320);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click();
    });

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    expect(stored["artist:merge:albums"]).toBe(320);
    expect(stored["artist:merge:videos"]).toBe(0);
  });

  it("keeps last scroll when unmount collapses the strip and clamps scrollLeft to 0", async () => {
    function CollapsingCarouselPage() {
      // Intentionally skip makeScrollable — this test needs real scrollWidth collapse.
      const ref = useHorizontalScrollRestore("artist:collapse:videos");
      const [wide, setWide] = useState(true);
      const navigate = useNavigate();
      return (
        <div>
          <div data-testid="carousel" ref={ref} style={{ width: "100px", overflowX: "auto", display: "flex" }}>
            {wide ? <div data-testid="wide-child" style={{ width: "500px", flexShrink: 0 }}>wide</div> : null}
          </div>
          <button type="button" onClick={() => setWide(false)}>collapse</button>
          <button type="button" onClick={() => navigate("/detail")}>open</button>
        </div>
      );
    }

    ({ root, container } = mount(
      <MemoryRouter initialEntries={["/artist"]}>
        <Routes>
          <Route path="/artist" element={<CollapsingCarouselPage />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    ));

    const carousel = container!.querySelector<HTMLDivElement>('[data-testid="carousel"]')!;
    // Force layout metrics: wide while child present, collapsed after remove.
    Object.defineProperty(carousel, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(carousel, "scrollWidth", {
      configurable: true,
      get: () => (container!.querySelector('[data-testid="wide-child"]') ? 500 : 100),
    });

    await act(async () => {
      carousel.scrollLeft = 400;
      carousel.dispatchEvent(new Event("scroll"));
    });
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}")["artist:collapse:videos"]).toBe(400);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button")!.click(); // collapse
    });
    await act(async () => {
      carousel.scrollLeft = 0;
      carousel.dispatchEvent(new Event("scroll"));
    });
    // Collapse-clamped zero must not overwrite the real offset.
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}")["artist:collapse:videos"]).toBe(400);

    await act(async () => {
      container!.querySelectorAll("button")[1].click(); // open
    });
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}")["artist:collapse:videos"]).toBe(400);
  });
});
