import type Database from "better-sqlite3";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { getConfigSection } from "../config/config.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";
import { parseMediaFormats } from "./media-formats.js";
import { editionRendition, planEligibleForEdition } from "./rendition-policy.js";
import { ArtistStatisticsService } from "./artist-statistics-service.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import {
  planHeadlineQualitySql,
  planQualityHistogramSql,
} from "../../utils/display-quality-sql.js";

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
  /** Canonical tracks delivered, out of `targetTrackCount`. */
  coverage: number;
  targetTrackCount: number;
  qualityTier: string;
  explicitContent: "explicit" | "clean" | "unknown";
  displayQuality: string | null;
  /**
   * Selected-variant counts per canonical tier. The headline is a maximum, so
   * only this tells "1 Max + 9 High" apart from "10 Max".
   */
  qualityHistogram: Record<string, number>;
}

/** `{"lossless": 9, "hires-lossless": 1}` from the plan-histogram SQL. */
function parseQualityHistogram(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const counts: Record<string, number> = {};
    for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) counts[tier] = count;
    }
    return counts;
  } catch {
    return {};
  }
}

export interface LibraryReleaseSelectionView {
  /** Null when this Edition was evaluated but is not monitored. */
  libraryEditionId: number | null;
  editionId: number;
  releaseMbid: string;
  /** A LibraryEditions row exists for this Library and Edition. */
  monitored: boolean;
  /** The Primary edition of this Album in this Library. */
  representative: boolean;
  selectionMode: "auto" | "manual";
  /** The Album lock — one value for every Edition of the Album in this Library. */
  locked: boolean;
  /** The plan that will actually be executed. Null unless monitored. */
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
  /** Unique medium formats from MusicBrainz (e.g. Digital Media, CD, Vinyl). */
  mediaFormats: string[];
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
  media: string | null;
}

/**
 * A specifically clean or explicit Edition shows only its own rendition.
 *
 * The planner already drops these before they are stored; this keeps the view
 * consistent for plans persisted before the gate existed, and both read the
 * same policy so they cannot drift apart again.
 */
export function planAllowedForEditionLabel(
  plan: Pick<LibraryAcquisitionPlanView, "explicitContent">,
  title: string | null | undefined,
  disambiguation: string | null | undefined,
): boolean {
  return planEligibleForEdition(plan.explicitContent, editionRendition(title, disambiguation));
}

/**
 * Group plans by provider for display: providers ordered by their best (lowest)
 * rank so preference is preserved, but clean+explicit from the same provider
 * sit together (one provider mark, not icon spam).
 */
export function sortPlansGroupedByProvider(
  plans: readonly LibraryAcquisitionPlanView[],
): LibraryAcquisitionPlanView[] {
  const byRank = [...plans].sort((left, right) =>
    left.rank - right.rank || left.id - right.id);
  const groups = new Map<string, LibraryAcquisitionPlanView[]>();
  const providerOrder: string[] = [];
  for (const plan of byRank) {
    const list = groups.get(plan.provider);
    if (!list) {
      providerOrder.push(plan.provider);
      groups.set(plan.provider, [plan]);
    } else {
      list.push(plan);
    }
  }
  return providerOrder.flatMap((provider) => groups.get(provider) || []);
}

/**
 * Edition and plan selection for one Album in one Library.
 *
 * **Every mutating method here is a user action.** That is what makes the Album
 * lock legible: `LibraryAlbums.locked` protects the Album's state from
 * *automation* — curation may not drop its Editions, planning may not replace
 * its selected offer, coverage optimisation may not reclaim its manual
 * preference. It was never a write barrier against the person who pressed it.
 * A locked Album that returned 409 to its own owner made Lock unusable: the
 * only way to change one's mind was to unlock, change, and relock, and every
 * one of those steps could be forgotten halfway.
 *
 * So the user may replace the Edition, add or remove Editions, change the
 * representative, choose another plan and unlock — all while locked, and the
 * lock survives every one of them. It disappears exactly once: when the last
 * monitored Edition goes and the `LibraryAlbums` row it lives on goes with it.
 *
 * Automation reads the lock elsewhere — `LibraryCurationService` skips locked
 * Albums, `AcquisitionPlanRepository` honours a locked plan preference — and
 * that is the only side the lock has ever needed to face.
 */
export class LibraryReleaseSelectionService {
  constructor(private readonly db: Database.Database) {}

  private notifyMonitoringChanged(input: {
    releaseGroupMbid: string;
    libraryId: number;
    reason: string;
  }): void {
    ArtistStatisticsService.refreshForReleaseGroupMbids([input.releaseGroupMbid]);
    emitLibraryUpdated({
      reason: input.reason,
      releaseGroupMbids: [input.releaseGroupMbid],
      libraryIds: [input.libraryId],
    });
  }

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
             media_count, track_count, media
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
      mediaFormats: parseMediaFormats(release.media),
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

    // One row per enabled Library × canonical Edition, whether or not that
    // Edition is monitored. Monitoring is derived from the LEFT JOIN: an Edition
    // with no LibraryEditions row is simply unmonitored, and still carries its
    // plans so the user can see what switching to it would get them.
    const libraryRows = this.db.prepare(`
      SELECT
        library.id AS library_id,
        library.name AS library_name,
        quality.name AS quality_profile,
        quality.allowed_source_formats,
        edition.id AS edition_id,
        edition.mbid AS release_mbid,
        monitored_edition.id AS library_edition_id,
        monitored_edition.selection_mode,
        monitored_edition.representative,
        monitored_edition.plan_selection_mode,
        monitored_edition.preferred_plan_key,
        COALESCE(library_album.locked, 0) AS locked
      FROM Libraries library
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      JOIN AlbumEditions edition ON edition.release_group_id = ?
      LEFT JOIN LibraryAlbums library_album
        ON library_album.library_id = library.id
       AND library_album.release_group_id = edition.release_group_id
      LEFT JOIN LibraryEditions monitored_edition
        ON monitored_edition.library_id = library.id
       AND monitored_edition.edition_id = edition.id
      WHERE library.enabled = 1
      ORDER BY library.id, edition.id
    `).all(releaseGroup.id) as Array<{
      library_id: number;
      library_name: string;
      quality_profile: string;
      allowed_source_formats: string;
      edition_id: number;
      release_mbid: string;
      library_edition_id: number | null;
      selection_mode: LibraryReleaseSelectionView["selectionMode"] | null;
      representative: number | null;
      plan_selection_mode: LibraryReleaseSelectionView["planSelectionMode"] | null;
      preferred_plan_key: string | null;
      locked: number;
    }>;
    const libraryById = new Map<number, LibrarySelectionView>();
    const preferredPlanKeyByEdition = new Map<string, string | null>();
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
      preferredPlanKeyByEdition.set(
        `${row.library_id}:${row.edition_id}`,
        row.preferred_plan_key,
      );
      library.selections.push({
        libraryEditionId: row.library_edition_id,
        editionId: row.edition_id,
        releaseMbid: row.release_mbid,
        monitored: row.library_edition_id != null,
        representative: Boolean(row.representative),
        selectionMode: row.selection_mode ?? "auto",
        locked: Boolean(row.locked),
        planSelectionMode: row.plan_selection_mode ?? "auto",
        plan: null,
        plans: [],
      });
    }

    // Every viable plan per (Library, canonical Edition) — including Editions
    // curation evaluated and did not monitor, which is what makes offering an
    // alternative Edition possible at all.
    const libraries = [...libraryById.values()];
    if (libraries.length > 0) {
      const planRows = this.db.prepare(`
        SELECT
          plan.id,
          plan.library_id,
          plan.edition_id,
          plan.plan_key,
          plan.provider,
          plan.composition,
          plan.download_mode,
          plan.state,
          plan.rank,
          plan.coverage,
          plan.target_track_count,
          plan.quality_tier,
          plan.explicit_content,
          ${planHeadlineQualitySql("plan.id")} AS display_quality,
          ${planQualityHistogramSql("plan.id")} AS quality_histogram,
          source.provider_edition_match_id,
          source.role
        FROM AcquisitionPlans plan
        JOIN Libraries library ON library.id = plan.library_id AND library.enabled = 1
        JOIN AlbumEditions edition ON edition.id = plan.edition_id
        LEFT JOIN AcquisitionPlanSources source ON source.plan_id = plan.id
        WHERE edition.release_group_id = ?
        ORDER BY plan.library_id, plan.edition_id, plan.rank, plan.id, source.sort_order
      `).all(releaseGroup.id) as Array<{
        id: number;
        library_id: number;
        edition_id: number;
        plan_key: string;
        provider: string;
        composition: LibraryAcquisitionPlanView["composition"];
        download_mode: LibraryAcquisitionPlanView["downloadMode"];
        state: LibraryAcquisitionPlanView["state"];
        rank: number;
        coverage: number;
        target_track_count: number;
        quality_tier: string;
        explicit_content: "explicit" | "clean" | "unknown";
        display_quality: string | null;
        quality_histogram: string | null;
        provider_edition_match_id: number | null;
        role: "primary" | "supplement" | null;
      }>;

      const planViewById = new Map<number, LibraryAcquisitionPlanView>();
      const plansByEdition = new Map<string, LibraryAcquisitionPlanView[]>();
      for (const planRow of planRows) {
        const scopeKey = `${planRow.library_id}:${planRow.edition_id}`;
        let view = planViewById.get(planRow.id);
        if (!view) {
          const selectedKey = preferredPlanKeyByEdition.get(scopeKey) ?? null;
          view = {
            id: planRow.id,
            planKey: planRow.plan_key,
            provider: planRow.provider,
            primaryProviderEditionMatchId: null,
            providerEditionMatchIds: [],
            composition: planRow.composition,
            downloadMode: planRow.download_mode,
            state: planRow.state,
            chosen: selectedKey != null && selectedKey === planRow.plan_key,
            selectionMode: "auto",
            rank: planRow.rank,
            coverage: planRow.coverage,
            targetTrackCount: planRow.target_track_count,
            qualityTier: planRow.quality_tier,
            explicitContent: planRow.explicit_content,
            displayQuality: planRow.display_quality || null,
            qualityHistogram: parseQualityHistogram(planRow.quality_histogram),
          };
          planViewById.set(planRow.id, view);
          const list = plansByEdition.get(scopeKey) || [];
          list.push(view);
          plansByEdition.set(scopeKey, list);
        }
        if (planRow.provider_edition_match_id != null) {
          view.providerEditionMatchIds.push(planRow.provider_edition_match_id);
          if (planRow.role === "primary") {
            view.primaryProviderEditionMatchId = planRow.provider_edition_match_id;
          }
        }
      }

      const releaseMetaById = new Map(
        releases.map((release) => [release.id, release] as const),
      );
      for (const library of libraries) {
        for (const selection of library.selections) {
          const release = releaseMetaById.get(selection.editionId);
          const rawPlans = plansByEdition.get(`${library.id}:${selection.editionId}`) || [];
          // Gate clean↔explicit against a clear MB edition label, then group by
          // provider so TIDAL clean+explicit sit together in the Editions UI.
          const plans = sortPlansGroupedByProvider(
            rawPlans.filter((plan) => planAllowedForEditionLabel(
              plan,
              release?.title,
              release?.disambiguation,
            )),
          );
          selection.plans = plans;
          for (const plan of plans) plan.selectionMode = selection.planSelectionMode;
          // Only a monitored Edition executes a plan. An unmonitored one lists
          // its offers without any of them being the one that runs.
          // If the stored preference was gated out (e.g. clean plan on an
          // explicit MB edition), do not surface it as chosen.
          selection.plan = selection.monitored
            ? plans.find((plan) => plan.chosen) ?? null
            : null;
        }
      }
    }

    // Track-list navigation is an Album-wide question answered by
    // AlbumTrackListNavigationService on `/page`. Availability enriches that
    // page with offers and plans; it must not also decide which lists exist.
    return {
      releaseGroupId: releaseGroup.id,
      releaseGroupMbid: releaseGroup.mbid,
      libraries,
      releases,
    };
  }

  /**
   * Choose an Edition and the offer that acquires it, in one action.
   *
   * A plan card sits under a canonical Edition that may or may not be monitored,
   * so clicking one has to mean the whole thing: monitor this Edition for this
   * Library and execute exactly this offer. One plan per edition — never several.
   *
   * `mode: "exclusive"` (plain click on an unmonitored edition) is "use only
   * this" — it replaces every other monitored Edition of the Album in this
   * Library and takes over as the representative.
   *
   * `mode: "additive"` (Ctrl/Cmd+click, or a plan switch on an already-monitored
   * edition) keeps other monitored editions. One plan per edition either way —
   * additive never stacks two plans on the same card.
   *
   * Neither mode presses Lock. Lock is a separate, explicit action, and it is
   * what makes a choice permanent rather than merely preferred.
   */
  choosePlan(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
    planKey: string;
    mode?: "exclusive" | "additive";
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.requireTargetEdition(input);
    const exclusive = input.mode !== "additive";

    this.db.transaction(() => {
      this.ensureLibraryAlbum(input.libraryId, target.releaseGroupId);
      this.monitorEdition({
        libraryId: input.libraryId,
        editionId: input.editionId,
        releaseGroupId: target.releaseGroupId,
        exclusive,
      });
      if (!new AcquisitionPlanRepository(this.db).selectPlan({
        libraryId: input.libraryId,
        editionId: input.editionId,
        planKey: input.planKey,
      })) {
        throw new Error(
          `No acquisition plan ${input.planKey} exists for this library and edition`,
        );
      }
    })();
    this.notifyMonitoringChanged({
      releaseGroupMbid: input.releaseGroupMbid,
      libraryId: input.libraryId,
      reason: "acquisition-plan-selected",
    });
    return this.getAvailability(input.releaseGroupMbid);
  }

  /**
   * Stop monitoring one Edition.
   *
   * Removing the representative promotes the best remaining Edition; removing
   * the last one unmonitors the Album itself. Files are never touched — that is
   * a separate, explicit deletion command.
   */
  removeEdition(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.requireTargetEdition(input);

    this.db.transaction(() => {
      const removed = this.db.prepare(`
        DELETE FROM LibraryEditions WHERE library_id = ? AND edition_id = ?
      `).run(input.libraryId, input.editionId).changes;
      if (removed === 0) return;

      const remaining = this.db.prepare(`
        SELECT monitored_edition.id, monitored_edition.representative
        FROM LibraryEditions monitored_edition
        JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
        WHERE monitored_edition.library_id = ? AND edition.release_group_id = ?
        ORDER BY edition.track_count DESC, COALESCE(edition.date, '9999-99-99'),
                 edition.id
      `).all(input.libraryId, target.releaseGroupId) as Array<{
        id: number;
        representative: number;
      }>;

      if (remaining.length === 0) {
        // No monitored Edition left means the Album is no longer monitored here.
        // Canonical metadata, provider matches and candidate plans all survive.
        this.db.prepare(`
          DELETE FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?
        `).run(input.libraryId, target.releaseGroupId);
        return;
      }
      if (!remaining.some((edition) => edition.representative)) {
        this.db.prepare(`
          UPDATE LibraryEditions
          SET representative = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(remaining[0].id);
      }
    })();
    this.notifyMonitoringChanged({
      releaseGroupMbid: input.releaseGroupMbid,
      libraryId: input.libraryId,
      reason: "edition-unmonitored",
    });
    LibraryFilesService.pruneUnmonitoredForReleaseGroup(input.releaseGroupMbid);
    return this.getAvailability(input.releaseGroupMbid);
  }

  /** Make an already-monitored Edition the Primary one for its Album. */
  makeRepresentative(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.requireTargetEdition(input);
    this.db.transaction(() => {
      const promoted = this.db.prepare(`
        UPDATE LibraryEditions
        SET representative = 1, updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ?
      `).run(input.libraryId, input.editionId).changes;
      if (promoted === 0) throw new Error("This edition is not monitored in this library");
      this.demoteOtherEditions(input.libraryId, input.editionId, target.releaseGroupId);
    })();
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
    this.requireTargetEdition(input);
    this.db.prepare(`
      UPDATE LibraryEditions
      SET preferred_plan_key = NULL, plan_selection_mode = 'auto',
          updated_at = CURRENT_TIMESTAMP
      WHERE library_id = ? AND edition_id = ?
    `).run(input.libraryId, input.editionId);
    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    new AcquisitionPlanningService(this.db).compute({
      libraryId: input.libraryId,
      editionId: input.editionId,
      providerPriority: Array.isArray(configuredPriority)
        ? configuredPriority.map(String)
        : [],
      plannerVersion: 1,
    });
    return this.getAvailability(input.releaseGroupMbid);
  }

  private requireTargetEdition(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
  }): { editionId: number; releaseGroupId: number; locked: boolean } {
    const row = this.db.prepare(`
      SELECT
        edition.id AS edition_id,
        edition.release_group_id,
        COALESCE(library_album.locked, 0) AS locked
      FROM AlbumEditions edition
      JOIN Albums release_group ON release_group.id = edition.release_group_id
      JOIN Libraries library ON library.id = ? AND library.enabled = 1
      LEFT JOIN LibraryAlbums library_album
        ON library_album.library_id = library.id
       AND library_album.release_group_id = edition.release_group_id
      WHERE edition.id = ? AND release_group.mbid = ?
    `).get(input.libraryId, input.editionId, input.releaseGroupMbid) as {
      edition_id: number;
      release_group_id: number;
      locked: number;
    } | undefined;
    if (!row) {
      throw new Error("This edition does not belong to this enabled library and album");
    }
    return {
      editionId: row.edition_id,
      releaseGroupId: row.release_group_id,
      locked: Boolean(row.locked),
    };
  }

  private ensureLibraryAlbum(libraryId: number, releaseGroupId: number): void {
    this.db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, selection_mode, locked,
        reason, curation_version, updated_at
      ) VALUES (?, ?, 'manual', 0, 'user', 1, CURRENT_TIMESTAMP)
      ON CONFLICT(library_id, release_group_id) DO UPDATE SET
        selection_mode = 'manual',
        reason = 'user',
        updated_at = CURRENT_TIMESTAMP
    `).run(libraryId, releaseGroupId);
  }

  /**
   * Monitor one Edition, either as the sole choice or alongside the existing set.
   *
   * An Edition that is already monitored keeps its representative flag in both
   * modes: switching its plan is not a reason to reshuffle the Album.
   */
  private monitorEdition(input: {
    libraryId: number;
    editionId: number;
    releaseGroupId: number;
    exclusive: boolean;
  }): void {
    const existing = this.db.prepare(`
      SELECT id, representative FROM LibraryEditions
      WHERE library_id = ? AND edition_id = ?
    `).get(input.libraryId, input.editionId) as {
      id: number;
      representative: number;
    } | undefined;

    if (input.exclusive) {
      this.db.prepare(`
        DELETE FROM LibraryEditions
        WHERE library_id = ?
          AND edition_id != ?
          AND edition_id IN (SELECT id FROM AlbumEditions WHERE release_group_id = ?)
      `).run(input.libraryId, input.editionId, input.releaseGroupId);
    }

    if (existing) {
      // Already monitored: an exclusive click promotes it, an additive click
      // leaves the Album's representative exactly where it was.
      if (input.exclusive) {
        this.db.prepare(`
          UPDATE LibraryEditions
          SET representative = 1, selection_mode = 'manual', reason = 'user',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(existing.id);
      }
      return;
    }

    // A newly added supplemental Edition must not steal the representative from
    // the Edition that already has it.
    const albumHasRepresentative = !input.exclusive && Boolean(this.db.prepare(`
      SELECT 1 FROM LibraryEditions monitored_edition
      JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
      WHERE monitored_edition.library_id = ?
        AND edition.release_group_id = ?
        AND monitored_edition.representative = 1
    `).get(input.libraryId, input.releaseGroupId));

    // Manual selection records a preference; it does not silently press Lock.
    // Only the explicit Album lock protects a choice from being reconsidered by
    // coverage-driven curation.
    this.db.prepare(`
      INSERT INTO LibraryEditions (
        library_id, edition_id, selection_mode, representative, reason,
        curation_version, selected_at, updated_at
      ) VALUES (?, ?, 'manual', ?, 'user', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(input.libraryId, input.editionId, albumHasRepresentative ? 0 : 1);
    if (input.exclusive) {
      this.demoteOtherEditions(input.libraryId, input.editionId, input.releaseGroupId);
    }
  }

  private demoteOtherEditions(
    libraryId: number,
    editionId: number,
    releaseGroupId: number,
  ): void {
    this.db.prepare(`
      UPDATE LibraryEditions
      SET representative = 0, updated_at = CURRENT_TIMESTAMP
      WHERE library_id = ?
        AND edition_id != ?
        AND representative = 1
        AND edition_id IN (SELECT id FROM AlbumEditions WHERE release_group_id = ?)
    `).run(libraryId, editionId, releaseGroupId);
  }

  /**
   * Monitor a canonical Edition for a Library.
   *
   * Same contract as clicking a plan, minus the plan: the default is "use only
   * this", replacing whatever else the Album had monitored here. An Album may
   * still legitimately keep several monitored Editions — deluxe beside standard,
   * a stereo choice beside a spatial one — but that is the deliberate additive
   * action (`mode: "additive"`, Ctrl/Cmd+click in the UI), not a plain click.
   */
  selectRelease(input: {
    releaseGroupMbid: string;
    libraryId: number;
    editionId: number;
    providerEditionMatchId?: number;
    mode?: "exclusive" | "additive";
  }): LibraryReleaseGroupAvailabilityView {
    const target = this.requireTargetEdition(input);
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

    this.db.transaction(() => {
      this.ensureLibraryAlbum(input.libraryId, target.releaseGroupId);
      this.monitorEdition({
        libraryId: input.libraryId,
        editionId: input.editionId,
        releaseGroupId: target.releaseGroupId,
        exclusive: input.mode !== "additive",
      });
    })();

    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    new AcquisitionPlanningService(this.db).compute({
      libraryId: input.libraryId,
      editionId: input.editionId,
      providerPriority: Array.isArray(configuredPriority)
        ? configuredPriority.map(String)
        : [],
      plannerVersion: 1,
      preferredProviderEditionMatchId: input.providerEditionMatchId,
    });
    if (input.providerEditionMatchId != null) {
      // Naming a Provider Edition is a plan choice, not just an edition choice.
      // Recording it as manual is what lets the next replan recognise and keep
      // it instead of quietly re-ranking to a different offer.
      this.db.prepare(`
        UPDATE LibraryEditions
        SET plan_selection_mode = 'manual', updated_at = CURRENT_TIMESTAMP
        WHERE library_id = ? AND edition_id = ? AND preferred_plan_key IS NOT NULL
      `).run(input.libraryId, input.editionId);
    }
    this.notifyMonitoringChanged({
      releaseGroupMbid: input.releaseGroupMbid,
      libraryId: input.libraryId,
      reason: "edition-monitored",
    });
    return this.getAvailability(input.releaseGroupMbid);
  }
}
