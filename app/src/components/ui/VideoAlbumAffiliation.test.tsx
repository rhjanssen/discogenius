import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoAlbumRefContract, VideoDetailContract } from "@contracts/media";
import { VideoAlbumAffiliation } from "./VideoAlbumAffiliation";

afterEach(cleanup);

const albums: VideoAlbumRefContract[] = [
  { id: "rg-monitored", title: "Monitored album", is_monitored: true },
  { id: "rg-other", title: "Other album", is_monitored: false },
];

const relatedTracks: NonNullable<VideoDetailContract["related_tracks"]> = [
  {
    id: 10,
    title: "Song",
    album_title: "Monitored album",
    album_id: "rg-monitored",
    edition_id: 100,
    edition_title: "Monitored album",
    edition_disambiguation: "Deluxe",
    edition_media_formats: ["Digital Media"],
    edition_track_count: 12,
    placement_library_id: 1,
    library_name: "Stereo",
  },
  {
    id: 11,
    title: "Song",
    album_title: "Monitored album",
    album_id: "rg-monitored",
    edition_id: 101,
    edition_title: "Monitored album",
    edition_disambiguation: "Standard",
    edition_media_formats: ["CD"],
    edition_track_count: 10,
    placement_library_id: 1,
    library_name: "Stereo",
  },
];

function renderAffiliation() {
  const onPlacementChange = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter>
        <VideoAlbumAffiliation
          albums={albums}
          placement={{
            mode: "inline",
            inline_track_id: 10,
            placement_library_id: 1,
          }}
          relatedTracks={relatedTracks}
          onPlacementChange={onPlacementChange}
        />
      </MemoryRouter>
    </FluentProvider>,
  );
  return onPlacementChange;
}

describe("VideoAlbumAffiliation", () => {
  it("keeps one release-group card while editions live in its placement menu", () => {
    renderAffiliation();

    expect(screen.getAllByRole("button", { name: /Open album Monitored album/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Open album Other album/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Choose an edition of Monitored album/i }));
    expect(screen.getByRole("menuitemradio", { name: /Deluxe.*Digital.*12 tracks/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Standard.*CD.*10 tracks/i })).toBeInTheDocument();
  });

  it("reveals unmonitored release groups without duplicating monitored cards", () => {
    renderAffiliation();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 unmonitored" }));

    expect(screen.getAllByRole("button", { name: /Open album Monitored album/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Open album Other album/i })).toBeInTheDocument();
  });

  it("keeps navigation and placement as sibling controls", () => {
    renderAffiliation();
    const navigation = screen.getByRole("button", { name: /Open album Monitored album/i });
    const placement = screen.getByRole("button", { name: /Choose an edition of Monitored album/i });

    expect(navigation.contains(placement)).toBe(false);
    expect(placement.contains(navigation)).toBe(false);
  });
});
