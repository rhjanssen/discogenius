import path from "path";
import type Database from "better-sqlite3";

/**
 * Release one TrackFiles row to UnmappedFiles (same path, same file on disk).
 * Takes the database explicitly so services that receive their own handle can use it.
 */
export function moveTrackFileToUnmapped(database: Database.Database, id: number, reason: string): boolean {
  const row = database.prepare("SELECT * FROM TrackFiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  const filePath = String(row.file_path);
  const libraryRoot = String(row.library_root ?? path.dirname(filePath));
  const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
  database.transaction(() => {
    database.prepare(`
      INSERT INTO UnmappedFiles (
        file_path, relative_path, library_root, filename, extension, file_size, duration,
        bitrate, sample_rate, bit_depth, channels, codec, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET reason = excluded.reason, updated_at = CURRENT_TIMESTAMP
    `).run(
      filePath,
      String(row.relative_path ?? path.relative(libraryRoot, filePath)),
      libraryRoot,
      String(row.filename ?? path.basename(filePath)),
      String(row.extension ?? path.extname(filePath).replace(/^\./, "")),
      num(row.file_size),
      num(row.duration ?? (row.duration_ms != null ? Number(row.duration_ms) / 1000 : null)),
      num(row.bitrate),
      num(row.sample_rate),
      num(row.bit_depth),
      num(row.channels ?? row.channel_count),
      row.codec == null ? null : String(row.codec),
      reason,
    );
    database.prepare("DELETE FROM TrackFiles WHERE id = ?").run(id);
  })();
  return true;
}
