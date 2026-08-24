import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";
import { ReleaseSwitcher } from "./ReleaseSwitcher";

describe("ReleaseSwitcher", () => {
  it("keeps the exact remove action available when a monitored edition has no current plan", () => {
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
        <ReleaseSwitcher
          availability={availability}
          onSelect={vi.fn()}
          onRemoveEdition={onRemoveEdition}
        />
      </FluentProvider>,
    );

    expect(screen.getByText("No current plan")).toBeTruthy();
    const remove = screen.getByRole("button", {
      name: "Stop monitoring Providerless edition in the stereo library",
    });
    fireEvent.click(remove);
    expect(onRemoveEdition).toHaveBeenCalledWith(7, 11);
  });
});
