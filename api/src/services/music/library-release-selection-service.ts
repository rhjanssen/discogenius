import type Database from "better-sqlite3";
import { getConfigSection } from "../config/config.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";

export interface LibraryAcquisitionPlanView {
  id: number;
  planKey: string;
  provider: string;
  primaryProviderEditionMatchId: number | null;
  providerEditionMatchIds: number[];
  composition: "single_source" | "composite";
  downloadMode: "album" | "tracks";
  state: "current" | "stale" | "unavailable" | "failed";
  chosen: boolean;
  selectionMode: "auto" | "manual";
  rank: number;
  coverage: number;
  qualityTier: string;
  explicitContent: "explicit" | "clean" | "unknown";
}

export interface LibraryReleaseSelectionView {
  libraryEditionId: number;
  editionId: number;
  releaseMbid: string;
  selectionMode: "auto" | "manual";
  locked: boolean;
  /** The plan that will actually be executed. */
  plan: LibraryAcquisitionPlanView | null;
  /** Every viable plan for this edition, best-ranked first. */
  plans: LibraryAcquisitionPlanView[];
  /** Whether the chosen plan was picked by the user or by the planner. */
  planSelectionMode: "auto" | "manual";
}

export interface LibrarySelectionView {
  id: number;
  name: string;
  qualityProfile: string;
  allowedSourceFormats: string[];
  selections: LibraryReleaseSelectionView[];
}

export interface ProviderReleaseOfferView {
  providerEditionMatchId: number;
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
          providerEditionMatchId: row.provider_edition_match_id,
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
        quality.allowed_source_formats,
        library_release.id AS library_edition_id,
        library_release.edition_id,
        release.mbid AS release_mbid,
        library_release.selection_mode,
        library_release.locked,
        library_release.plan_selection_mode,
        plan.id AS plan_id,
        plan.provider AS plan_provider,
        plan.composition,
        plan.download_mode,
        plan.state AS plan_state
        ,primary_source.provider_edition_match_id AS primary_provider_edition_match_id
      FROM Libraries library
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      LEFT JOIN LibraryEditions library_release
        ON library_release.library_id = library.id
       AND library_release.edition_id IN (
         SELECT id FROM AlbumEditions WHERE release_group_id = ?
       )
      LEFT JOIN AlbumEditions release ON release.id = library_release.edition_id
      LEFT JOIN AcquisitionPlans plan
        ON plan.library_edition_id = library_release.id
       AND plan.state = 'current'
       AND plan.chosen = 1
      LEFT JOIN AcquisitionPlanSources primary_source
        ON primary_source.plan_id = plan.id
       AND primary_source.role = 'primary'
      WHERE library.enabled = 1
      ORDER BY library.id, library_release.id
    `).all(releaseGroup.id) as Array<{
      library_id: number;
      library_name: string;
      quality_profile: string;
      allowed_source_formats: string;
      library_edition_id: number | null;
      edition_id: number | null;
      release_mbid: string | null;
      selection_mode: LibraryReleaseSelectionView["selectionMode"] | null;
      locked: number | null;
      plan_selection_mode: LibraryReleaseSelectionView["planSelectionMode"] | null;
      plan_id: number | null;
      plan_provider: string | null;
      composition: LibraryAcquisitionPlanView["composition"] | null;
      download_mode: LibraryAcquisitionPlanView["downloadMode"] | null;
      plan_state: LibraryAcquisitionPlanView["state"] | null;
      primary_provider_edition_match_id: number | null;
    }>;
    const libraryById = new Map<number, LibrarySelectionView>();
    for (const row of libraryRows) {
      let library = libraryById.get(row.library_id);
      if (!library) {
        library = {
          id: row.library_id,
          name: row.library_name,
          qualityProfile: row.quality_profile,
          allowedSourceFormats: (() => {
            try {
              const parsed = JSON.parse(row.allowed_source_formats);
              return Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
              return [];
            }
          })(),
          selections: [],
        };
        libraryById.set(row.library_id, library);
      }
      if (
        row.library_edition_id != null
        && row.edition_id != null
        && row.release_mbid
        && row.selection_mode
      ) {
        library.selections.push({
          libraryEditionId: row.library_edition_id,
          editionId: row.edition_id,
          releaseMbid: row.release_mbid,
          selectionMode: row.selection_mode,
          locked: Boolean(row.locked),
          planSelectionMode: row.plan_selection_mode ?? "auto",
          plan: null,
          plans: [],
        });
      }
    }

    // Every viable plan per selected edition, so a library can be offered its
    // real alternatives rather than only the one the planner ranked first.
    const libraries = [...libraryById.values()];
    const libraryEditionIds = libraries
      .flatMap((library) => library.selections.map((selection) => selection.libraryEditionId));
    if (libraryEditionIds.length > 0) {
      const placeholders = libraryEditionIds.map(() => "?").join(",");
      const planRows = this.db.prepare(`
        SELECT
          plan.id,
          plan.library_edition_id,
          plan.plan_key,
          plan.provider,
          plan.composition,
          plan.download_mode,
          plan.state,
          plan.chosen,
          plan.selection_mode,
          plan.rank,
          plan.coverage,
          plan.quality_tier,
          plan.explicit_content,
          source.provider_edition_match_id,
          source.role
        FROM AcquisitionPlans plan
        LEFT JOIN AcquisitionPlanSources source ON source.plan_id = plan.id
        WHERE plan.library_edition_id IN (${placeholders})
        ORDER BY plan.library_edition_id, plan.rank, plan.id, source.sort_order
      `).all(...libraryEditionIds) as Array<{
        id: number;
        library_edition_id: number;
        plan_key: string;
        provider: string;
        composition: LibraryAcquisitionPlanView["composition"];
        download_mode: LibraryAcquisitionPlanView["downloadMode"];
        state: LibraryAcquisitionPlanView["state"];
        chosen: number;
        selection_mode: LibraryAcquisitionPlanView["selectionMode"];
        rank: number;
        coverage: number;
        quality_tier: string;
        explicit_content: "explicit" | "clean" | "unknown";
        provider_edition_match_id: number | null;
        role: "primary" | "supplement" | null;
      }>;

      const planViewById = new Map<number, LibraryAcquisitionPlanView>();
      const plansByEdition = new Map<number, LibraryAcquisitionPlanView[]>();
      for (const planRow of planRows) {
        let view = planViewById.get(planRow.id);
        if (!view) {
          view = {
            id: planRow.id,
            planKey: planRow.plan_key,
            provider: planRow.provider,
            primaryProviderEditionMatchId: null,
            providerEditionMatchIds: [],
            composition: planRow.composition,
            downloadMode: planRow.download_mode,
            state: planRow.state,
            chosen: Boolean(planRow.chosen),
            selectionMode: planRow.selection_mode,
            rank: planRow.rank,
            coverage: planRow.coverage,
            qualityTier: planRow.quality_tier,
            explicitContent: planRow.explicit_content,
          };
          planViewById.set(planRow.id, view);
          const list = plansByEdition.get(planRow.library_edition_id) || [];
          list.push(view);
          plansByEdition.set(planRow.library_edition_id, list);
        }
        if (planRow.provider_edition_match_id != null) {
          view.providerEditionMatchIds.push(planRow.provider_edition_match_id);
          if (planRow.role === "primary") {
            view.primaryProviderEditionMatchId = planRow.provider_edition_match_id;
          }
        }
      }

      for (const library of libraries) {
        for (const selection of library.selections) {
          const plans = plansByEdition.get(selection.libraryEditionId) || [];
          selection.plans = plans;
          selection.plan = plans.find((plan) => plan.chosen) ?? null;
        }
      }
    }

    return {
      releaseGroupId: releaseGroup.id,
      releaseGroupMbid: releaseGroup.mbid,
      libraries,
      releases,
    };
  }

  /**
   * Pick which persisted acquisition plan a library executes for an edition.
   *
   * The choice is stored on LibraryEditions by plan_key so it outlives the plan
   * rows, which are rebuilt on every replan.
   */
  choosePlan(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
    planKey: string;
  }): LibraryReleaseGroupAvailabilityView {
    const libraryEdition = this.requireLibraryEdition(input);
    const planId = new AcquisitionPlanRepository(this.db)
      .choosePlan(libraryEdition.id, input.planKey);
    if (planId == null) {
      throw new Error(`No acquisition plan ${input.planKey} exists for this library edition`);
    }
    this.db.prepare(`
      UPDATE LibraryEditions
      SET preferred_plan_key = ?, plan_selection_mode = 'manual',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.planKey, libraryEdition.id);
    return this.getAvailability(input.releaseGroupMbid);
  }

  /**
   * Hand the plan choice back to the planner. The alternatives are re-ranked and
   * the best one becomes chosen again.
   */
  revertPlanToAutomatic(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
  }): LibraryReleaseGroupAvailabilityView {
    const libraryEdition = this.requireLibraryEdition(input);
    this.db.prepare(`
      UPDATE LibraryEditions
      SET preferred_plan_key = NULL, plan_selection_mode = 'auto',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(libraryEdition.id);
    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    new AcquisitionPlanningService(this.db).compute({
      libraryEditionId: libraryEdition.id,
      providerPriority: Array.isArray(configuredPriority)
        ? configuredPriority.map(String)
        : [],
      plannerVersion: 1,
    });
    return this.getAvailability(input.releaseGroupMbid);
  }

  private requireLibraryEdition(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
  }): { id: number } {
    const row = this.db.prepare(`
      SELECT library_release.id
      FROM LibraryEditions library_release
      JOIN AlbumEditions release ON release.id = library_release.edition_id
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Libraries library ON library.id = library_release.library_id AND library.enabled = 1
      WHERE library_release.library_id = ?
        AND library_release.edition_id = ?
        AND release_group.mbid = ?
    `).get(input.libraryId, input.editionId, input.releaseGroupMbid) as { id?: number } | undefined;
    if (!row?.id) {
      throw new Error("This edition is not selected for this enabled library");
    }
    return { id: row.id };
  }

  /**
   * Select a canonical Edition for a Library.
   *
   * An Album may legitimately have several selected Editions in one Library —
   * deluxe versus standard, regional variants, a stereo choice beside a spatial
   * one, or a canonical Edition covered by a Provider superset. Selecting one
   * therefore clears only the Editions curation chose automatically; another
   * Edition the user deliberately locked survives.
   *
   * `exclusive: true` is the explicit product action that reduces the Album to
   * this single Edition. It is never implied by an ordinary selection.
   */
  selectRelease(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
    providerEditionMatchId?: number;
    exclusive?: boolean;
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.db.prepare(`
      SELECT release.id AS edition_id, release.release_group_id
      FROM AlbumEditions release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Libraries library ON library.id = ? AND library.enabled = 1
      WHERE release.id = ? AND release_group.mbid = ?
    `).get(input.libraryId, input.editionId, input.releaseGroupMbid) as {
      edition_id: number;
      release_group_id: number;
    } | undefined;
    if (!target) throw new Error("The selected release does not belong to this enabled library and release group");
    if (input.providerEditionMatchId != null) {
      const offer = this.db.prepare(`
        SELECT match.id
        FROM ProviderEditionMatches match
        JOIN ProviderItems item
          ON item.id = match.provider_edition_item_id
         AND item.entity_type = 'release'
        WHERE match.id = ?
          AND match.edition_id = ?
          AND match.match_state = 'accepted'
          AND item.availability NOT IN (
            'unavailable', 'no_longer_available', 'geography_restricted',
            'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
          )
      `).get(input.providerEditionMatchId, input.editionId);
      if (!offer) {
        throw new Error("The selected provider offer is not an accepted, available match for this edition");
      }
    }

    const libraryEditionId = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO LibraryAlbums (
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
        DELETE FROM LibraryEditions
        WHERE library_id = ?
          AND edition_id != ?
          AND edition_id IN (
            SELECT id FROM AlbumEditions WHERE release_group_id = ?
          )
          AND locked = 0
          AND (? = 1 OR selection_mode = 'auto')
      `).run(
        input.libraryId,
        input.editionId,
        target.release_group_id,
        input.exclusive === true ? 1 : 0,
      );
      // Manual selection records a preference; it does not silently press Lock.
      // Locking is a separate, explicit Album-level action, and only it protects
      // a choice from being reconsidered by coverage-driven curation.
      return (this.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, locked, reason,
          curation_version, selected_at, updated_at
        ) VALUES (?, ?, 'manual', 0, 'user', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, edition_id) DO UPDATE SET
          selection_mode = 'manual',
          reason = 'user',
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `).get(input.libraryId, input.editionId) as { id: number }).id;
    })();

    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    new AcquisitionPlanningService(this.db).compute({
      libraryEditionId,
      providerPriority: Array.isArray(configuredPriority)
        ? configuredPriority.map(String)
        : [],
      plannerVersion: 1,
      preferredProviderEditionMatchId: input.providerEditionMatchId,
    });
    return this.getAvailability(input.releaseGroupMbid);
  }
}
