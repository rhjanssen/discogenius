import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";
import { EditionsSummaryBar } from "./EditionsSummaryBar";
import { ManageEditionsDialog } from "./ManageEditionsDialog";

function makePlan(overrides: Partial<ReleaseGroupAvailability["libraries"][number]["selections"][number]["plans"][number]> = {}): ReleaseGroupAvailability["libraries"][number]["selections"][number]["plans"][number] {
  return {
    id: 1,
    planKey: "tidal:hires-lossless:explicit:101",
    provider: "tidal",
    qualityTier: "hires-lossless",
    explicitContent: "explicit",
    composition: "single_source" as const,
    downloadMode: "album" as const,
    coverage: 10,
    targetTrackCount: 10,
    rank: 1,
    state: "current" as const,
    providerEditionMatchIds: [101],
    primaryProviderEditionMatchId: 101,
    ...overrides,
    chosen: overrides.chosen ?? false,
    selectionMode: overrides.selectionMode ?? ("auto" as const),
    displayQuality: overrides.displayQuality ?? "HIRES_LOSSLESS",
    qualityHistogram: overrides.qualityHistogram ?? { "hires-lossless": 10 },
  };
}

function makeAvailability(): ReleaseGroupAvailability {
  const stdPlanTidal = makePlan({
    id: 1,
    planKey: "tidal:hires-lossless:explicit:101",
    provider: "tidal",
    qualityTier: "hires-lossless",
    rank: 1,
    providerEditionMatchIds: [101],
    primaryProviderEditionMatchId: 101,
  });
  const stdPlanDeezer = makePlan({
    id: 2,
    planKey: "deezer:lossless:clean:102",
    provider: "deezer",
    qualityTier: "lossless",
    explicitContent: "clean",
    rank: 2,
    providerEditionMatchIds: [102],
    primaryProviderEditionMatchId: 102,
  });
  const dlxPlanTidal = makePlan({
    id: 3,
    planKey: "tidal:lossless:explicit:201",
    provider: "tidal",
    qualityTier: "lossless",
    rank: 1,
    coverage: 14,
    targetTrackCount: 14,
    providerEditionMatchIds: [201],
    primaryProviderEditionMatchId: 201,
  });
  const spatialPlanApple = makePlan({
    id: 4,
    planKey: "apple_music:spatial:explicit:301",
    provider: "apple_music",
    qualityTier: "spatial",
    rank: 1,
    providerEditionMatchIds: [301],
    primaryProviderEditionMatchId: 301,
  });

  return {
    releaseGroupId: 1,
    releaseGroupMbid: "rg-mbid",
    libraries: [
      {
        id: 10,
        name: "Stereo",
        qualityProfile: "HiRes",
        allowedSourceFormats: ["hires-lossless", "lossless", "lossy"],
        selections: [
          {
            libraryEditionId: 1001,
            editionId: 11,
            releaseMbid: "rel-std",
            monitored: true,
            representative: true,
            selectionMode: "auto",
            locked: false,
            planSelectionMode: "auto",
            plan: stdPlanTidal,
            plans: [stdPlanTidal, stdPlanDeezer],
          },
          {
            libraryEditionId: 1002,
            editionId: 12,
            releaseMbid: "rel-dlx",
            monitored: false,
            representative: false,
            selectionMode: "auto",
            locked: false,
            planSelectionMode: "auto",
            plan: null,
            plans: [dlxPlanTidal],
          },
        ],
      },
      {
        id: 20,
        name: "Spatial",
        qualityProfile: "Spatial",
        allowedSourceFormats: ["spatial"],
        selections: [
          {
            libraryEditionId: 2001,
            editionId: 11,
            releaseMbid: "rel-std",
            monitored: true,
            representative: true,
            selectionMode: "auto",
            locked: false,
            planSelectionMode: "auto",
            plan: spatialPlanApple,
            plans: [spatialPlanApple],
          },
        ],
      },
    ],
    releases: [
      {
        id: 11,
        mbid: "rel-std",
        title: "Standard Edition",
        disambiguation: null,
        status: "Official",
        date: "2024-01-01",
        country: "XW",
        mediumCount: 1,
        trackCount: 10,
        mediaFormats: ["Digital Media"],
        offers: [
          {
            providerEditionMatchId: 101,
            providerItemId: 1001,
            provider: "tidal",
            providerId: "tidal-101",
            providerUrl: "https://tidal.com/album/101",
            matchState: "accepted",
            confidence: 1,
            relation: "exact",
            availability: "available",
            variants: [{ id: 1, qualityClass: "hires-lossless", spatialFormat: null, availability: "available", codec: null, container: null }],
          },
          {
            providerEditionMatchId: 102,
            providerItemId: 1002,
            provider: "deezer",
            providerId: "deezer-102",
            providerUrl: "https://deezer.com/album/102",
            matchState: "accepted",
            confidence: 0.95,
            relation: "exact",
            availability: "available",
            variants: [{ id: 2, qualityClass: "lossless", spatialFormat: null, availability: "available", codec: null, container: null }],
          },
          {
            providerEditionMatchId: 301,
            providerItemId: 1003,
            provider: "apple_music",
            providerId: "apple-301",
            providerUrl: "https://music.apple.com/album/301",
            matchState: "accepted",
            confidence: 0.99,
            relation: "exact",
            availability: "available",
            variants: [{ id: 3, qualityClass: "spatial", spatialFormat: "atmos", availability: "available", codec: null, container: null }],
          },
        ],
      },
      {
        id: 12,
        mbid: "rel-dlx",
        title: "Deluxe Edition",
        disambiguation: "2024 Remaster",
        status: "Official",
        date: "2024-03-01",
        country: "GB",
        mediumCount: 2,
        trackCount: 14,
        mediaFormats: ["Digital Media"],
        offers: [
          {
            providerEditionMatchId: 201,
            providerItemId: 1004,
            provider: "tidal",
            providerId: "tidal-201",
            providerUrl: "https://tidal.com/album/201",
            matchState: "accepted",
            confidence: 0.98,
            relation: "exact",
            availability: "available",
            variants: [{ id: 4, qualityClass: "lossless", spatialFormat: null, availability: "available", codec: null, container: null }],
          },
        ],
      },
      {
        id: 13,
        mbid: "rel-vinyl",
        title: "Limited Vinyl",
        disambiguation: "180g",
        status: "Official",
        date: "2024-04-01",
        country: "DE",
        mediumCount: 1,
        trackCount: 10,
        mediaFormats: ["12\" Vinyl"],
        offers: [],
      },
    ],
  };
}

describe("EditionsSummaryBar & ManageEditionsDialog", () => {
  it("renders summary bar and opens the manage dialog", () => {
    const onOpenDialog = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <EditionsSummaryBar
          availability={makeAvailability()}
          onOpenDialog={onOpenDialog}
        />
      </FluentProvider>,
    );

    expect(screen.getByText("Stereo")).toBeTruthy();
    expect(screen.getByText("Spatial")).toBeTruthy();
    expect(screen.getByText(/TIDAL · Hi-Res · Explicit · Auto/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Manage editions & sources/i }));
    expect(onOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("supports exclusive vs additive monitoring, plan selection, and revert to automatic", () => {
    const onSelectPlan = vi.fn();
    const onRevertPlan = vi.fn();
    const onRemoveEdition = vi.fn();

    render(
      <FluentProvider theme={webLightTheme}>
        <ManageEditionsDialog
          open={true}
          onClose={vi.fn()}
          availability={makeAvailability()}
          onSelect={vi.fn()}
          onSelectPlan={onSelectPlan}
          onRevertPlan={onRevertPlan}
          onRemoveEdition={onRemoveEdition}
        />
      </FluentProvider>,
    );

    // Default: Keep other monitored editions is OFF -> monitoring Deluxe is exclusive
    const monitorDeluxe = screen.getByRole("switch", {
      name: /Monitor Deluxe Edition in the stereo library/i,
    });
    fireEvent.click(monitorDeluxe);
    expect(onSelectPlan).toHaveBeenCalledWith(10, 12, "tidal:lossless:explicit:201", "exclusive");

    // Turn Keep other monitored editions ON -> monitoring Deluxe is additive
    fireEvent.click(screen.getByRole("switch", { name: /Keep other monitored editions/i }));
    fireEvent.click(monitorDeluxe);
    expect(onSelectPlan).toHaveBeenLastCalledWith(10, 12, "tidal:lossless:explicit:201", "additive");

    // Switch plan on monitored Standard Edition to Deezer
    fireEvent.click(screen.getByRole("button", { name: /Deezer · Lossless · Clean/i }));
    expect(onSelectPlan).toHaveBeenLastCalledWith(10, 11, "deezer:lossless:clean:102", "additive");

    // Revert monitored Standard Edition back to Automatic
    const autoButtons = screen.getAllByRole("button", { name: /Automatic \(best per settings\)/i });
    fireEvent.click(autoButtons[0]);
    expect(onRevertPlan).toHaveBeenCalledWith(10, 11);

    // Unmonitor Standard Edition
    const unmonitorStd = screen.getByRole("switch", {
      name: /Stop monitoring Standard Edition in the stereo library/i,
    });
    fireEvent.click(unmonitorStd);
    expect(onRemoveEdition).toHaveBeenCalledWith(10, 11);
  });

  it("shows Set as Primary when multiple editions are monitored and calls onSetRepresentative", () => {
    const availability = makeAvailability();
    availability.libraries[0].selections[1].monitored = true;
    const onSetRepresentative = vi.fn();

    render(
      <FluentProvider theme={webLightTheme}>
        <ManageEditionsDialog
          open={true}
          onClose={vi.fn()}
          availability={availability}
          onSelect={vi.fn()}
          onSetRepresentative={onSetRepresentative}
        />
      </FluentProvider>,
    );

    const setPrimary = screen.getByRole("button", { name: "Set as Primary" });
    fireEvent.click(setPrimary);
    expect(onSetRepresentative).toHaveBeenCalledWith(10, 12);
  });

  it("supports library tabs, search filtering, and showing all MusicBrainz editions", () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <ManageEditionsDialog
          open={true}
          onClose={vi.fn()}
          availability={makeAvailability()}
          onSelect={vi.fn()}
        />
      </FluentProvider>,
    );

    // Unmatched Vinyl edition is hidden by default
    expect(screen.queryByText("Limited Vinyl")).toBeNull();

    // Toggle "Show all MusicBrainz editions"
    fireEvent.click(screen.getByRole("switch", { name: /Show all MusicBrainz editions/i }));
    expect(screen.getByText("Limited Vinyl")).toBeTruthy();

    // Filter by search
    fireEvent.change(screen.getByRole("textbox", { name: /Filter editions/i }), {
      target: { value: "Vinyl" },
    });
    expect(screen.getByText("Limited Vinyl")).toBeTruthy();
    expect(screen.queryByText("Deluxe Edition")).toBeNull();

    // Clear search and switch to Spatial tab
    fireEvent.change(screen.getByRole("textbox", { name: /Filter editions/i }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Spatial" }));
    expect(screen.getByText(/Apple Music · Spatial · Explicit/i)).toBeTruthy();
  });

  it("keeps unmonitor available when a monitored edition has no current plan", () => {
    const onRemoveEdition = vi.fn();
    const availability: ReleaseGroupAvailability = {
      releaseGroupId: 1,
      releaseGroupMbid: "album-mbid",
      libraries: [{
        id: 7,
        name: "Stereo",
        qualityProfile: "Lossless",
        allowedSourceFormats: ["lossless"],
        selections: [{
          libraryEditionId: 19,
          editionId: 11,
          releaseMbid: "edition-mbid",
          monitored: true,
          representative: true,
          selectionMode: "manual",
          locked: false,
          planSelectionMode: "auto",
          plan: null,
          plans: [],
        }],
      }],
      releases: [{
        id: 11,
        mbid: "edition-mbid",
        title: "Providerless edition",
        disambiguation: null,
        status: "Official",
        date: "2024-01-01",
        country: "XW",
        mediumCount: 1,
        trackCount: 10,
        mediaFormats: ["Digital Media"],
        offers: [],
      }],
    };

    render(
      <FluentProvider theme={webLightTheme}>
        <ManageEditionsDialog
          open={true}
          onClose={vi.fn()}
          availability={availability}
          onSelect={vi.fn()}
          onRemoveEdition={onRemoveEdition}
        />
      </FluentProvider>,
    );

    expect(screen.getByText("No current plan")).toBeTruthy();
    const remove = screen.getByRole("switch", {
      name: /Stop monitoring Providerless edition in the stereo library/i,
    });
    fireEvent.click(remove);
    expect(onRemoveEdition).toHaveBeenCalledWith(7, 11);
  });
});
