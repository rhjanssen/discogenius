import { normalizeArtistFolderInput, resolveArtistFolderFromTemplate } from "./artist-paths.js";

type ArtistPathBuilderArtist = {
  id?: string | number | null;
  name: string | null;
  mbid?: string | null;
  path?: string | null;
};

export class ArtistPathBuilder {
  static buildPath(artist: ArtistPathBuilderArtist, useExistingRelativeFolder: boolean): string {
    const existingPath = String(artist.path || "").trim();

    if (useExistingRelativeFolder && existingPath) {
      return normalizeArtistFolderInput(existingPath);
    }

    return resolveArtistFolderFromTemplate({
      artistId: artist.id ?? null,
      artistName: String(artist.name || "Unknown Artist"),
      artistMbId: artist.mbid ?? null,
    });
  }
}
