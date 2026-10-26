import type Database from "better-sqlite3";

/**
 * Karaoke, tribute, and "originally performed by" products are not the
 * MusicBrainz release. Matching must not accept them. Stored rows stay until
 * a person decides; this module only recognises them and lists files.
 */

const MARKERS = [
  "karaoke",
  "tribute to",
  "in the style of",
  "originally performed by",
  "cover version",
] as const;

export function isDerivativeProviderRelease(input: {
  title?: string | null;
  version?: string | null;
  artistCredit?: string | null;
  label?: string | null;
}): boolean {
  const haystack = [input.title, input.version, input.artistCredit, input.label]
    .map((part) => String(part || "").toLowerCase())
    .join("\n");
  return MARKERS.some((marker) => haystack.includes(marker));
}

export interface DerivativeSourceFile {
  filePath: string;
  provider: string | null;
  providerId: string | null;
  sourceTitle: string | null;
  marker: string;
}

/**
 * On-disk files whose provider release or track title/credit is a karaoke,
 * tribute, or cover stand-in. Read-only. Nothing is deleted.
 */
function markerSql(column: string): string {
  return MARKERS.map(() => `LOWER(${column}) LIKE ?`).join(" OR ");
}

export function listDerivativeSourceFiles(db: Database.Database): DerivativeSourceFile[] {
  const params = MARKERS.map((marker) => `%${marker}%`);
  const rows = db.prepare(`
    SELECT file.file_path AS file_path,
           item.provider AS provider,
           item.provider_id AS provider_id,
           item.title AS source_title,
           LOWER(COALESCE(item.title, '') || ' ' || COALESCE(item.version, '') || ' ' || COALESCE(credits.names, '')) AS blob
    FROM TrackFiles file
    JOIN ProviderItems item ON item.id = file.provider_item_id
    LEFT JOIN (
      SELECT item_id, GROUP_CONCAT(credited_name, ' ') AS names
      FROM ProviderItemCredits
      GROUP BY item_id
    ) credits ON credits.item_id = item.id
    WHERE file.file_path IS NOT NULL
      AND (${markerSql("COALESCE(item.title, '') || ' ' || COALESCE(item.version, '') || ' ' || COALESCE(credits.names, '')")})

    UNION

    SELECT file.file_path,
           release_item.provider,
           release_item.provider_id,
           release_item.title,
           LOWER(COALESCE(release_item.title, '') || ' ' || COALESCE(release_item.version, '') || ' ' || COALESCE(credits.names, ''))
    FROM TrackFiles file
    JOIN ProviderEditionMatches match
      ON match.edition_id = file.album_edition_id
     AND match.match_state = 'accepted'
     AND match.decision_source = 'automatic'
    JOIN ProviderItems release_item ON release_item.id = match.provider_edition_item_id
    LEFT JOIN (
      SELECT item_id, GROUP_CONCAT(credited_name, ' ') AS names
      FROM ProviderItemCredits
      GROUP BY item_id
    ) credits ON credits.item_id = release_item.id
    WHERE file.file_path IS NOT NULL
      AND (${markerSql("COALESCE(release_item.title, '') || ' ' || COALESCE(release_item.version, '') || ' ' || COALESCE(credits.names, '')")})
  `).all(...params, ...params) as Array<{
    file_path: string;
    provider: string | null;
    provider_id: string | null;
    source_title: string | null;
    blob: string;
  }>;

  const seen = new Set<string>();
  const files: DerivativeSourceFile[] = [];
  for (const row of rows) {
    const marker = MARKERS.find((candidate) => row.blob.includes(candidate)) ?? "karaoke";
    const key = `${row.file_path}\u0000${row.provider || ""}\u0000${row.provider_id || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      filePath: row.file_path,
      provider: row.provider,
      providerId: row.provider_id,
      sourceTitle: row.source_title,
      marker,
    });
  }
  return files;
}
