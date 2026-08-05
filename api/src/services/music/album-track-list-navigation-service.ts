import type Database from "better-sqlite3";
import type { TrackListTabContract } from "../../contracts/pages.js";
import { parseMediaFormats } from "./media-formats.js";
import { loadCoverageUnitsForRecordings } from "./coverage-identity-repository.js";
import { resolveTrackListTabs, type TrackListEditionInput } from "./track-list-tabs.js";

export interface AlbumTrackListNavigationInfo {
  tabs: TrackListTabContract[];
  initialTrackListEditionId: number | null;
}

/** One monitored Edition of the Album, joined across every enabled Library. */
interface MonitoredEditionRow {
  edition_id: number;
  release_mbid: string;
  title: string;
  disambiguation: string | null;
  country: string | null;
  media: string | null;
  track_count: number | null;
  is_representative: number;
}

interface EditionRecordingRow {
  album_edition_id: number;
  recording_id: number;
}

export class AlbumTrackListNavigationService {
  constructor(private readonly db: Database.Database) {}

  getNavigationInfo(releaseGroupMbid: string): AlbumTrackListNavigationInfo {
    const releaseGroup = this.db.prepare(
      "SELECT id FROM Albums WHERE mbid = ?"
    ).get(releaseGroupMbid) as { id: number } | undefined;

    if (!releaseGroup) {
      return { tabs: [], initialTrackListEditionId: null };
    }

    const monitoredEditions = this.db.prepare(`
      SELECT
        edition.id AS edition_id,
        edition.mbid AS release_mbid,
        edition.title,
        edition.disambiguation,
        edition.country,
        edition.media,
        edition.track_count,
        MAX(monitored.representative) AS is_representative
      FROM AlbumEditions edition
      JOIN LibraryEditions monitored ON monitored.edition_id = edition.id
      JOIN Libraries library ON library.id = monitored.library_id AND library.enabled = 1
      WHERE edition.release_group_id = ?
      GROUP BY edition.id
      ORDER BY edition.id ASC
    `).all(releaseGroup.id) as MonitoredEditionRow[];

    if (monitoredEditions.length === 0) {
      return { tabs: [], initialTrackListEditionId: null };
    }

    const editionRecordingRows = this.db.prepare(`
      SELECT track.album_edition_id, track.recording_id
      FROM Tracks track
      JOIN AlbumEditions edition ON edition.id = track.album_edition_id
      WHERE edition.release_group_id = ?
        AND track.recording_id IS NOT NULL
    `).all(releaseGroup.id) as EditionRecordingRow[];

    // Coverage identity is resolved over this Album's Recordings only. Clean and
    // explicit twins of one performance still collapse to a single tab; nothing
    // outside the Album can change that, and nothing outside it is loaded.
    const { unitByRecording } = loadCoverageUnitsForRecordings(
      this.db,
      editionRecordingRows.map((row) => row.recording_id),
    );
    const acquisitionUnitIdsByEdition = new Map<number, Set<number>>();
    for (const row of editionRecordingRows) {
      const unitIds = acquisitionUnitIdsByEdition.get(row.album_edition_id) ?? new Set<number>();
      unitIds.add(unitByRecording.get(row.recording_id) ?? row.recording_id);
      acquisitionUnitIdsByEdition.set(row.album_edition_id, unitIds);
    }

    const inputs: TrackListEditionInput[] = monitoredEditions.map((edition) => ({
      editionId: edition.edition_id,
      recordingIds: acquisitionUnitIdsByEdition.get(edition.edition_id) ?? new Set<number>(),
      representative: Boolean(edition.is_representative),
    }));

    const editionById = new Map(monitoredEditions.map((edition) => [edition.edition_id, edition]));
    const tabs: TrackListTabContract[] = resolveTrackListTabs(inputs).map((tab) => {
      const edition = editionById.get(tab.editionId);
      if (!edition) {
        // resolveTrackListTabs only ever returns ids it was given; a miss means
        // the two collections have drifted and the page would silently show the
        // wrong Edition's metadata.
        throw new Error(
          `Track-list tab resolved to edition ${tab.editionId}, which is not a monitored edition of ${releaseGroupMbid}`,
        );
      }
      return {
        editionId: edition.edition_id,
        releaseMbid: edition.release_mbid,
        title: edition.title,
        disambiguation: edition.disambiguation ?? null,
        country: edition.country ?? null,
        mediaFormats: parseMediaFormats(edition.media),
        trackCount: edition.track_count ?? null,
        default: tab.default,
      };
    });

    return {
      tabs,
      initialTrackListEditionId: tabs.find((tab) => tab.default)?.editionId ?? null,
    };
  }
}
