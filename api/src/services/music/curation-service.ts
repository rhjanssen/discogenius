import { db, withSqliteWriteGate } from "../../database.js";
import { emitLibraryUpdated } from "../commands/app-events.js";
import {
  loadArtistMetadataIdentity,
} from "./managed-artists.js";
import {
  ACQUISITION_PLANNER_VERSION,
  AcquisitionPlanningService,
  getAcquisitionProviderPriority,
} from "./acquisition-planning-service.js";
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
    const providerPriority = getAcquisitionProviderPriority();
    const curation = new LibraryCurationService(db);
    const planning = new AcquisitionPlanningService(db);
    const planEdition = (libraryId: number, editionId: number, label: string) => withSqliteWriteGate(
      () => planning.compute({ libraryId, editionId, providerPriority, plannerVersion: ACQUISITION_PLANNER_VERSION }),
      label,
    );
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
      // Plans are a fingerprinted cache of provider evidence and each edition's
      // plan stands alone, so other writers may run between editions. Only the
      // monitoring decision must not interleave with a user's exclusion or
      // lock, and that alone holds the gate. One gate around everything held
      // the writer for 57 s on a large catalogue and failed every worker write
      // that waited past its 15 s limit.
      const scope = { libraryArtistIds };
      for (const editionId of curation.candidateEditionIds({ libraryId: library.id, scope })) {
        await planEdition(library.id, editionId, "curation:edition-plan");
      }
      const curated = await withSqliteWriteGate(() => curation.curateLibrary({
        libraryId: library.id,
        curationVersion: 1,
        acquisitionPlannerVersion: ACQUISITION_PLANNER_VERSION,
        providerPriority,
        scope,
        planning: "caller",
      }), "curation:audio-library");
      for (const editionId of curated.selectedEditionIds) {
        await planEdition(library.id, editionId, "curation:replan-selected");
      }
      emitLibraryUpdated({ reason: "library-curated", libraryIds: [library.id] });
    }
    // Videos are curated after the audio editions, because inline placement can
    // only choose among Tracks of Editions that are monitored — which the loop
    // above has just decided.
    const identityMbid = String(identity.artistMbid || "").trim();
    if (identityMbid) {
      for (const summary of await withSqliteWriteGate(() => curateArtistVideos(db, identityMbid), "curation:videos")) {
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
