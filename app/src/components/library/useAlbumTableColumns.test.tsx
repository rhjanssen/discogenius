import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAlbumTableColumns } from "./useAlbumTableColumns";

describe("useAlbumTableColumns", () => {
  it("keeps the library and artist album tables in one canonical relative order", () => {
    const library = renderHook(() => useAlbumTableColumns({
      showArtist: true,
      renderActions: () => null,
    }));
    const artist = renderHook(() => useAlbumTableColumns({
      renderActions: () => null,
    }));

    expect(library.result.current.map((column) => column.key)).toEqual([
      "thumb",
      "title",
      "artist",
      "year",
      "tracks",
      "quality",
      "localQuality",
      "actions",
    ]);
    expect(artist.result.current.map((column) => column.key)).toEqual([
      "thumb",
      "title",
      "year",
      "tracks",
      "quality",
      "localQuality",
      "actions",
    ]);
    expect(artist.result.current.map((column) => column.header)).toContain("Provider");
    expect(artist.result.current.map((column) => column.header)).toContain("Local Files");
  });
});
