import type Database from "better-sqlite3";
import { getConfigSection } from "../config/config.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";

export interface LibraryAcquisitionPlanView {
  id: number;
  provider: string;
  composition: "single_source" | "composite";
  downloadMode: "album" | "tracks";
  state: "current" | "stale" | "unavailable" | "failed";
}

export interface LibraryReleaseSelectionView {
  libraryReleaseId: number;
  releaseId: number;
  releaseMbid: string;
  selectionMode: "auto" | "manual";
  locked: boolean;
  plan: LibraryAcquisitionPlanView | null;
}

export interface LibrarySelectionView {
  id: number;
  name: string;
  qualityProfile: string;
  selections: LibraryReleaseSelectionView[];
}

export interface ProviderReleaseOfferView {
  providerReleaseMatchId: number;
  providerItemId: number;
  provider: string;
  providerId: string;
  providerUrl: string | null;
  availability: string;
  relation: "exact" | "source_superset" | "source_subset" | "overlap";
  matchState: "candidate" | "accepted" | "ambiguous" | "rejected";
  confidence: number;
  variants: Array<{
    id: number;
    qualityClass: "lossy" | "lossless" | "hires-lossless" | "spatial";
    availability: string;
    codec: string | null;
    container: string | null;
    spatialFormat: string | null;
  }>;
}

export interface CanonicalReleaseAvailabilityView {
  id: number;
  mbid: string;
  title: string;
  disambiguation: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  mediumCount: number | null;
  trackCount: number | null;
  offers: ProviderReleaseOfferView[];
}

export interface LibraryReleaseGroupAvailabilityView {
  releaseGroupId: number;
  releaseGroupMbid: string;
  libraries: LibrarySelectionView[];
  releases: CanonicalReleaseAvailabilityView[];
}

interface ReleaseRow {
  id: number;
  mbid: string;
  title: string;
  disambiguation: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  media_count: number | null;
  track_count: number | null;
}

export class LibraryReleaseSelectionService {
  constructor(private readonly db: Database.Database) {}

  getAvailability(releaseGroupMbid: string): LibraryReleaseGroupAvailabilityView {
    const releaseGroup = this.db.prepare(`
      SELECT id, mbid
      FROM Albums
      WHERE mbid = ?
      LIMIT 1
    `).get(releaseGroupMbid) as { id: number; mbid: string } | undefined;
    if (!releaseGroup) throw new Error(`Unknown release group ${releaseGroupMbid}`);

    const releaseRows = this.db.prepare(`
      SELECT id, mbid, title, disambiguation, status, date, country,
             media_count, track_count
      FROM AlbumEditions
      WHERE release_group_id = ?
      ORDER BY COALESCE(date, '9999-99-99'), id
    `).all(releaseGroup.id) as ReleaseRow[];
    const releases = releaseRows.map((release) => ({
      id: release.id,
      mbid: release.mbid,
      title: release.title,
      disambiguation: release.disambiguation,
      status: release.status,
      date: release.date,
      country: release.country,
      mediumCount: release.media_count,
      trackCount: release.track_count,
      offers: [] as ProviderReleaseOfferView[],
    }));
    const releaseById = new Map(releases.map((release) => [release.id, release]));

    const offerRows = this.db.prepare(`
      SELECT
        match.id AS provider_edition_match_id,
        match.edition_id,
        match.relation,
        match.match_state,
        match.confidence,
        item.id AS provider_item_id,
        item.provider,
        item.provider_id,
        item.provider_url,
        item.availability,
        variant.id AS variant_id,
        variant.quality_class,
        variant.availability AS variant_availability,
        variant.codec,
        variant.container,
        variant.spatial_format
      FROM ProviderEditionMatches match
      JOIN ProviderItems item ON item.id = match.provider_edition_item_id
      LEFT JOIN ProviderItemAudioVariants variant ON variant.provider_item_id = item.id
      WHERE match.edition_id IN (
        SELECT id FROM AlbumEditions WHERE release_group_id = ?
      )
        AND match.match_state != 'rejected'
      ORDER BY match.edition_id, match.confidence DESC, match.id, variant.id
    `).all(releaseGroup.id) as Array<{
      provider_edition_match_id: number;
      edition_id: number;
      relation: ProviderReleaseOfferView["relation"];
      match_state: ProviderReleaseOfferView["matchState"];
      confidence: number;
      provider_item_id: number;
      provider: string;
      provider_id: string;
      provider_url: string | null;
      availability: string;
      variant_id: number | null;
      quality_class: ProviderReleaseOfferView["variants"][number]["qualityClass"] | null;
      variant_availability: string | null;
      codec: string | null;
      container: string | null;
      spatial_format: string | null;
    }>;
    const offerByMatchId = new Map<number, ProviderReleaseOfferView>();
    for (const row of offerRows) {
      const release = releaseById.get(row.edition_id);
      if (!release) continue;
      let offer = offerByMatchId.get(row.provider_edition_match_id);
      if (!offer) {
        offer = {
          providerReleaseMatchId: row.provider_edition_match_id,
          providerItemId: row.provider_item_id,
          provider: row.provider,
          providerId: row.provider_id,
          providerUrl: row.provider_url,
          availability: row.availability,
          relation: row.relation,
          matchState: row.match_state,
          confidence: row.confidence,
          variants: [],
        };
        offerByMatchId.set(row.provider_edition_match_id, offer);
        release.offers.push(offer);
      }
      if (row.variant_id != null && row.quality_class) {
        offer.variants.push({
          id: row.variant_id,
          qualityClass: row.quality_class,
          availability: row.variant_availability || "unknown",
          codec: row.codec,
          container: row.container,
          spatialFormat: row.spatial_format,
        });
      }
    }

    const libraryRows = this.db.prepare(`
      SELECT
        library.id AS library_id,
        library.name AS library_name,
        quality.name AS quality_profile,
        library_release.id AS library_release_id,
        library_release.edition_id,
        release.mbid AS release_mbid,
        library_release.selection_mode,
        library_release.locked,
        plan.id AS plan_id,
        plan.provider AS plan_provider,
        plan.composition,
        plan.download_mode,
        plan.state AS plan_state
      FROM Libraries library
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      LEFT JOIN LibraryReleases library_release
        ON library_release.library_id = library.id
       AND library_release.edition_id IN (
         SELECT id FROM AlbumEditions WHERE release_group_id = ?
       )
      LEFT JOIN AlbumEditions release ON release.id = library_release.edition_id
      LEFT JOIN AcquisitionPlans plan
        ON plan.library_release_id = library_release.id
       AND plan.state = 'current'
      WHERE library.enabled = 1
      ORDER BY library.id, library_release.id
    `).all(releaseGroup.id) as Array<{
      library_id: number;
      library_name: string;
      quality_profile: string;
      library_release_id: number | null;
      edition_id: number | null;
      release_mbid: string | null;
      selection_mode: LibraryReleaseSelectionView["selectionMode"] | null;
      locked: number | null;
      plan_id: number | null;
      plan_provider: string | null;
      composition: LibraryAcquisitionPlanView["composition"] | null;
      download_mode: LibraryAcquisitionPlanView["downloadMode"] | null;
      plan_state: LibraryAcquisitionPlanView["state"] | null;
    }>;
    const libraryById = new Map<number, LibrarySelectionView>();
    for (const row of libraryRows) {
      let library = libraryById.get(row.library_id);
      if (!library) {
        library = {
          id: row.library_id,
          name: row.library_name,
          qualityProfile: row.quality_profile,
          selections: [],
        };
        libraryById.set(row.library_id, library);
      }
      if (
        row.library_release_id != null
        && row.edition_id != null
        && row.release_mbid
        && row.selection_mode
      ) {
        library.selections.push({
          libraryReleaseId: row.library_release_id,
          releaseId: row.edition_id,
          releaseMbid: row.release_mbid,
          selectionMode: row.selection_mode,
          locked: Boolean(row.locked),
          plan: row.plan_id != null
            && row.plan_provider
            && row.composition
            && row.download_mode
            && row.plan_state
            ? {
              id: row.plan_id,
              provider: row.plan_provider,
              composition: row.composition,
              downloadMode: row.download_mode,
              state: row.plan_state,
            }
            : null,
        });
      }
    }
    return {
      releaseGroupId: releaseGroup.id,
      releaseGroupMbid: releaseGroup.mbid,
      libraries: [...libraryById.values()],
      releases,
    };
  }

  selectRelease(input: {
    releaseGroupMbid: string;
    libraryId: number;
    releaseId: number;
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.db.prepare(`
      SELECT release.id AS edition_id, release.release_group_id
      FROM AlbumEditions release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Libraries library ON library.id = ? AND library.enabled = 1
      WHERE release.id = ? AND release_group.mbid = ?
    `).get(input.libraryId, input.releaseId, input.releaseGroupMbid) as {
      edition_id: number;
      release_group_id: number;
    } | undefined;
    if (!target) throw new Error("The selected release does not belong to this enabled library and release group");

    const libraryReleaseId = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO LibraryReleaseGroups (
          library_id, release_group_id, monitored, selection_mode, locked,
          reason, curation_version, updated_at
        ) VALUES (?, ?, 1, 'manual', 1, 'user', 1, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, release_group_id) DO UPDATE SET
          monitored = 1,
          selection_mode = 'manual',
          locked = 1,
          reason = 'user',
          updated_at = CURRENT_TIMESTAMP
      `).run(input.libraryId, target.release_group_id);
      this.db.prepare(`
        DELETE FROM LibraryReleases
        WHERE library_id = ?
          AND edition_id IN (
            SELECT id FROM AlbumEditions WHERE release_group_id = ?
          )
      `).run(input.libraryId, target.release_group_id);
      return (this.db.prepare(`
        INSERT INTO LibraryReleases (
          library_id, edition_id, selection_mode, locked, reason,
          curation_version, selected_at, updated_at
        ) VALUES (?, ?, 'manual', 1, 'user', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
      `).get(input.libraryId, input.releaseId) as { id: number }).id;
    })();

    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    new AcquisitionPlanningService(this.db).compute({
      libraryReleaseId,
      providerPriority: Array.isArray(configuredPriority)
        ? configuredPriority.map(String)
        : [],
      plannerVersion: 1,
    });
    return this.getAvailability(input.releaseGroupMbid);
  }
}
