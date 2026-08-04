import type Database from "better-sqlite3";
import type { TrackListTabContract } from "../../contracts/pages.js";
import { loadAcquisitionUnitMapFromDb } from "./recording-coverage-units.js";
import { resolveTrackListTabs, type TrackListEditionInput } from "./track-list-tabs.js";

export interface AlbumTrackListNavigationInfo {
  tabs: TrackListTabContract[];
  initialTrackListEditionId: number | null;
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
    `).all(releaseGroup.id) as Array<{
      edition_id: number;
      release_mbid: string;
      title: string;
      disambiguation: string | null;
      country: string | null;
      media: string | null;
      track_count: number | null;
      is_representative: number;
    }>;

    if (monitoredEditions.length === 0) {
      return { tabs: [], initialTrackListEditionId: null };
    }

    const coverageUnitByRecording = loadAcquisitionUnitMapFromDb(this.db);
    const recordingIdsByEdition = new Map<number, Set<number>>();

    for (const row of this.db.prepare(`
      SELECT track.album_edition_id, track.recording_id
      FROM Tracks track
      JOIN AlbumEditions edition ON edition.id = track.album_edition_id
      WHERE edition.release_group_id = ?
        AND track.recording_id IS NOT NULL
    `).all(releaseGroup.id) as Array<{ album_edition_id: number; recording_id: number }>) {
      const recordingIds = recordingIdsByEdition.get(row.album_edition_id) || new Set<number>();
      recordingIds.add(
        coverageUnitByRecording.get(row.recording_id) ?? row.recording_id,
      );
      recordingIdsByEdition.set(row.album_edition_id, recordingIds);
    }

    const inputs: TrackListEditionInput[] = monitoredEditions.map((ed) => ({
      editionId: ed.edition_id,
      recordingIds: recordingIdsByEdition.get(ed.edition_id) || new Set<number>(),
      representative: Boolean(ed.is_representative),
    }));

    const resolvedTabs = resolveTrackListTabs(inputs);
    const monitoredEditionsMap = new Map(monitoredEditions.map((ed) => [ed.edition_id, ed]));

    const tabs: TrackListTabContract[] = resolvedTabs.map((tab) => {
      const ed = monitoredEditionsMap.get(tab.editionId)!;
      let mediaFormats: string[] = [];
      if (ed.media) {
        try {
          const parsed = JSON.parse(ed.media);
          if (Array.isArray(parsed)) mediaFormats = parsed.map(String);
          else mediaFormats = [String(ed.media)];
        } catch {
          mediaFormats = [String(ed.media)];
        }
      }
      return {
        editionId: ed.edition_id,
        releaseMbid: ed.release_mbid,
        title: ed.title,
        disambiguation: ed.disambiguation ?? null,
        country: ed.country ?? null,
        mediaFormats,
        trackCount: ed.track_count ?? null,
        default: tab.default,
      };
    });

    const defaultTab = tabs.find((t) => t.default) ?? tabs[0] ?? null;
    const initialTrackListEditionId = defaultTab ? defaultTab.editionId : null;

    return {
      tabs,
      initialTrackListEditionId,
    };
  }
}
