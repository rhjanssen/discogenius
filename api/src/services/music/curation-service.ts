import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import {
  loadArtistMetadataIdentity,
} from "./managed-artists.js";
import { LibraryCurationService } from "./library-curation-service.js";
import { curateArtistVideos } from "./video-curation-service.js";

interface ArtistCurationIdentity {
  canonicalArtistId: number | null;
  artistMbid: string | null;
}

export class CurationService {
  private static resolveIdentity(inputValue: string): ArtistCurationIdentity {
    const identity = loadArtistMetadataIdentity(inputValue);
    if (!identity) {
      return { canonicalArtistId: null, artistMbid: null };
    }
    return {
      canonicalArtistId: identity.id,
      artistMbid: identity.mbid,
    };
  }

  static async processAll(
    artistId: string,
  ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
    const identity = this.resolveIdentity(artistId);
    if (identity.canonicalArtistId == null || !identity.artistMbid) {
      return { newAlbums: 0, upgradedAlbums: 0 };
    }

    // Catalog-only / unmonitored artists stay out of LibraryArtists. Curation
    // never manufactures membership — that is add/monitor's job.
    const membership = loadArtistMetadataIdentity(artistId);
    if (!membership?.in_library) {
      return { newAlbums: 0, upgradedAlbums: 0 };
    }

    // AUDIO libraries only. A Video Library has no Albums, no Editions and no
    // acquisition plans to compose — running audio curation for one made the
    // audio planner reject its `video` quality policy and abort the whole cycle
    // before video curation ever ran. Videos are curated separately below.
    const libraries = db.prepare(`
      SELECT library.id
      FROM Libraries library
      JOIN LibraryArtists library_artist ON library_artist.library_id = library.id
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      WHERE library.enabled = 1
        AND library_artist.artist_metadata_id = ?
        AND library_artist.policy IN ('all', 'new')
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'video'
        )
      ORDER BY library.id
    `).all(identity.canonicalArtistId) as Array<{ id: number }>;
    const selectedBefore = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM LibraryEditions release
      JOIN LibraryEditionScopes scope ON scope.library_edition_id = release.id
      JOIN LibraryArtists artist ON artist.id = scope.library_artist_id
      WHERE artist.artist_metadata_id = ?
    `).get(identity.canonicalArtistId) as { count: number }).count);
    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    const providerPriority = Array.isArray(configuredPriority)
      ? configuredPriority.map(String)
      : [];
    const curation = new LibraryCurationService(db);
    for (const library of libraries) {
      // Curate this artist, not the whole library. The optimiser has always run
      // per LibraryArtist, so the decisions are identical either way — but an
      // unscoped pass re-planned every edition of every monitored artist, which
      // is why curating a one-album artist cost the same as curating everything.
      const libraryArtistIds = (db.prepare(`
        SELECT id FROM LibraryArtists
        WHERE library_id = ? AND artist_metadata_id = ?
      `).all(library.id, identity.canonicalArtistId) as Array<{ id: number }>).map(({ id }) => id);
      if (libraryArtistIds.length === 0) continue;
      curation.curateLibrary({
        libraryId: library.id,
        curationVersion: 1,
        acquisitionPlannerVersion: 1,
        providerPriority,
        scope: { libraryArtistIds },
      });
    }
    // Videos are curated after the audio editions, because inline placement can
    // only choose among Tracks of Editions that are monitored — which the loop
    // above has just decided.
    const identityMbid = String(identity.artistMbid || "").trim();
    if (identityMbid) {
      for (const summary of curateArtistVideos(db, identityMbid)) {
        console.log(
          `[Curation] Video library ${summary.libraryId} (${summary.layout}): `
          + `${summary.selected} selected (${summary.inline} inline, `
          + `${summary.separated} separated), ${summary.unselected} left unmonitored`,
        );
      }
    }

    const selectedAfter = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM LibraryEditions release
      JOIN LibraryEditionScopes scope ON scope.library_edition_id = release.id
      JOIN LibraryArtists artist ON artist.id = scope.library_artist_id
      WHERE artist.artist_metadata_id = ?
    `).get(identity.canonicalArtistId) as { count: number }).count);

    return {
      newAlbums: Math.max(0, selectedAfter - selectedBefore),
      upgradedAlbums: 0,
    };
  }
}
