import type Database from "better-sqlite3";
import type { TrackListTabContract } from "../../contracts/pages.js";

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

    const rows = this.db.prepare(`
      SELECT
        edition.id,
        edition.title,
        edition.disambiguation,
        edition.status,
        edition.country,
        edition.date,
        edition.media_count,
        edition.track_count,
        COALESCE(monitored.representative, 0) AS is_representative,
        CASE WHEN monitored.id IS NOT NULL THEN 1 ELSE 0 END AS is_monitored
      FROM AlbumEditions edition
      LEFT JOIN LibraryEditions monitored
        ON monitored.edition_id = edition.id
       AND monitored.library_id IN (SELECT id FROM Libraries WHERE enabled = 1)
      WHERE edition.release_group_id = ?
      ORDER BY
        COALESCE(monitored.representative, 0) DESC,
        CASE WHEN monitored.id IS NOT NULL THEN 1 ELSE 0 END DESC,
        COALESCE(edition.date, '9999-99-99') ASC,
        edition.id ASC
    `).all(releaseGroup.id) as Array<{
      id: number;
      title: string;
      disambiguation: string | null;
      status: string | null;
      country: string | null;
      date: string | null;
      media_count: number | null;
      track_count: number | null;
      is_representative: number;
      is_monitored: number;
    }>;

    const tabs: TrackListTabContract[] = rows.map((row) => {
      let tabTitle = row.title;
      if (row.disambiguation && row.disambiguation.trim()) {
        tabTitle = `${row.title} (${row.disambiguation.trim()})`;
      }
      return {
        id: row.id,
        title: tabTitle,
        isRepresentative: Boolean(row.is_representative),
        isMonitored: Boolean(row.is_monitored),
      };
    });

    const initialTrackListEditionId = tabs.length > 0 ? tabs[0].id : null;

    return {
      tabs,
      initialTrackListEditionId,
    };
  }
}
