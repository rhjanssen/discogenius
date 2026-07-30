import type Database from "better-sqlite3";

export interface CanonicalArtistInput {
  mbid: string;
  name: string;
  sortName?: string | null;
  disambiguation?: string | null;
  type?: string | null;
  country?: string | null;
}

export interface CanonicalCreditInput {
  artistId: number;
  ordinal: number;
  creditedName: string;
  joinPhrase?: string;
  role?: string | null;
}

export interface CanonicalReleaseGroupInput {
  mbid: string;
  title: string;
  primaryArtistId?: number | null;
  primaryType?: string | null;
  secondaryTypes?: readonly string[];
  firstReleaseDate?: string | null;
  disambiguation?: string | null;
}

export interface CanonicalReleaseInput {
  mbid: string;
  releaseGroupId: number;
  title: string;
  status?: string | null;
  country?: string | null;
  date?: string | null;
  barcode?: string | null;
  disambiguation?: string | null;
  mediaCount?: number | null;
  trackCount?: number | null;
  media?: unknown;
}

export interface CanonicalRecordingInput {
  mbid: string;
  title: string;
  lengthMs?: number | null;
  isVideo?: boolean;
  isrcs?: readonly string[];
}

export interface CanonicalTrackInput {
  mbid: string;
  releaseId: number;
  recordingId: number;
  mediumPosition: number;
  position: number;
  number?: string | null;
  title: string;
  lengthMs?: number | null;
}

function required(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optional(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export class CanonicalCatalogRepository {
  constructor(private readonly db: Database.Database) {}

  upsertArtist(input: CanonicalArtistInput): number {
    const row = this.db.prepare(`
      INSERT INTO ArtistMetadata (
        mbid, name, sort_name, disambiguation, type, country, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        name = excluded.name,
        sort_name = excluded.sort_name,
        disambiguation = excluded.disambiguation,
        type = excluded.type,
        country = excluded.country,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      required(input.mbid, "Artist MBID"),
      required(input.name, "Artist name"),
      optional(input.sortName),
      optional(input.disambiguation),
      optional(input.type),
      optional(input.country),
    ) as { id: number };
    return row.id;
  }

  upsertReleaseGroup(input: CanonicalReleaseGroupInput): number {
    const row = this.db.prepare(`
      INSERT INTO Albums (
        mbid, artist_metadata_id, title, primary_type, secondary_types,
        first_release_date, disambiguation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        artist_metadata_id = excluded.artist_metadata_id,
        title = excluded.title,
        primary_type = excluded.primary_type,
        secondary_types = excluded.secondary_types,
        first_release_date = excluded.first_release_date,
        disambiguation = excluded.disambiguation,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      required(input.mbid, "Release-group MBID"),
      input.primaryArtistId ?? null,
      required(input.title, "Release-group title"),
      optional(input.primaryType),
      JSON.stringify(input.secondaryTypes || []),
      optional(input.firstReleaseDate),
      optional(input.disambiguation),
    ) as { id: number };
    return row.id;
  }

  upsertRelease(input: CanonicalReleaseInput): number {
    const row = this.db.prepare(`
      INSERT INTO AlbumEditions (
        mbid, release_group_id, title, status, country, date, barcode,
        disambiguation, media_count, track_count, media, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        release_group_id = excluded.release_group_id,
        title = excluded.title,
        status = excluded.status,
        country = excluded.country,
        date = excluded.date,
        barcode = excluded.barcode,
        disambiguation = excluded.disambiguation,
        media_count = excluded.media_count,
        track_count = excluded.track_count,
        media = excluded.media,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      required(input.mbid, "Release MBID"),
      input.releaseGroupId,
      required(input.title, "Release title"),
      optional(input.status),
      optional(input.country),
      optional(input.date),
      optional(input.barcode),
      optional(input.disambiguation),
      input.mediaCount ?? null,
      input.trackCount ?? null,
      input.media == null ? null : JSON.stringify(input.media),
    ) as { id: number };
    return row.id;
  }

  upsertRecording(input: CanonicalRecordingInput): number {
    const row = this.db.prepare(`
      INSERT INTO Recordings (
        mbid, title, length_ms, is_video, isrcs, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        length_ms = excluded.length_ms,
        is_video = excluded.is_video,
        isrcs = excluded.isrcs,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      required(input.mbid, "Recording MBID"),
      required(input.title, "Recording title"),
      input.lengthMs ?? null,
      Number(Boolean(input.isVideo)),
      JSON.stringify(input.isrcs || []),
    ) as { id: number };
    return row.id;
  }

  upsertTrack(input: CanonicalTrackInput): number {
    const row = this.db.prepare(`
      INSERT INTO Tracks (
        mbid, album_edition_id, recording_id, medium_position, position,
        number, title, length_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        album_edition_id = excluded.album_edition_id,
        recording_id = excluded.recording_id,
        medium_position = excluded.medium_position,
        position = excluded.position,
        number = excluded.number,
        title = excluded.title,
        length_ms = excluded.length_ms,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      required(input.mbid, "Track MBID"),
      input.releaseId,
      input.recordingId,
      input.mediumPosition,
      input.position,
      optional(input.number),
      required(input.title, "Track title"),
      input.lengthMs ?? null,
    ) as { id: number };
    return row.id;
  }

  replaceReleaseGroupCredits(releaseGroupId: number, credits: readonly CanonicalCreditInput[]): void {
    this.replaceCredits(
      "ReleaseGroupArtistCredits",
      "release_group_id",
      releaseGroupId,
      credits,
    );
  }

  replaceReleaseCredits(releaseId: number, credits: readonly CanonicalCreditInput[]): void {
    this.replaceCredits("ReleaseArtistCredits", "edition_id", releaseId, credits);
  }

  replaceTrackCredits(trackId: number, credits: readonly CanonicalCreditInput[]): void {
    this.replaceCredits("TrackArtistCredits", "track_id", trackId, credits);
  }

  replaceRecordingCredits(recordingId: number, credits: readonly CanonicalCreditInput[]): void {
    this.replaceCredits("RecordingArtistCredits", "recording_id", recordingId, credits);
  }

  private replaceCredits(
    table: string,
    ownerColumn: string,
    ownerId: number,
    credits: readonly CanonicalCreditInput[],
  ): void {
    const ordinals = new Set<number>();
    for (const credit of credits) {
      if (ordinals.has(credit.ordinal)) throw new Error(`Duplicate canonical credit ordinal ${credit.ordinal}`);
      ordinals.add(credit.ordinal);
    }
    const insert = this.db.prepare(`
      INSERT INTO ${table} (
        ${ownerColumn}, artist_id, ordinal, credited_name, join_phrase, role
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`).run(ownerId);
      for (const credit of [...credits].sort((left, right) => left.ordinal - right.ordinal)) {
        insert.run(
          ownerId,
          credit.artistId,
          credit.ordinal,
          required(credit.creditedName, "Credited artist name"),
          credit.joinPhrase || "",
          optional(credit.role),
        );
      }
    })();
  }
}
