/**
 * Collapse global Settings onto the fixed Stereo / Spatial libraries.
 *
 * Until users can define their own libraries (Lidarr-style), the product surface
 * is intentionally small:
 *   - Settings → Audio quality  → Stereo library quality profile (preferred max)
 *   - Settings → Spatial toggle → Spatial library enabled (Atmos planning)
 *
 * Stereo quality is one ladder for every setting. Profiles share the same
 * allowed formats and preference order (hi-res → lossless → lossy). Settings
 * only picks the preferred maximum (cutoff) and whether to keep chasing above
 * it; lower rungs always remain valid fallbacks (SoundCloud / YouTube Music).
 *
 * Download backends (tiddl) still read `quality.audio_quality` as a delivery
 * ceiling; acquisition planning reads the library profile.
 */
import type Database from "better-sqlite3";
import type { QualityConfig } from "../config/config.js";

export type StereoAudioQuality = QualityConfig["audio_quality"];

const STEREO_LIBRARY_NAME = "Stereo";
const SPATIAL_LIBRARY_NAME = "Spatial";

/** Settings audio_quality value → quality_profiles.name */
export function stereoQualityProfileName(audioQuality: StereoAudioQuality): string {
  switch (audioQuality) {
    case "max":
      return "Max Quality";
    case "high":
      return "High Quality";
    case "normal":
      return "Normal Quality";
    case "low":
      return "Low Quality";
    default:
      return "Max Quality";
  }
}

/** Ensure the four stereo tiers + Spatial + Video profiles exist with stable definitions. */
export function ensureDefaultQualityProfiles(db: Database.Database): void {
  const upsert = db.prepare(`
    INSERT INTO quality_profiles (
      name, upgrade_allowed, cutoff, items, allowed_source_formats,
      preference_order, continue_upgrades, fallback_policy,
      output_format, transcode_policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      upgrade_allowed = excluded.upgrade_allowed,
      cutoff = excluded.cutoff,
      items = excluded.items,
      allowed_source_formats = excluded.allowed_source_formats,
      preference_order = excluded.preference_order,
      continue_upgrades = excluded.continue_upgrades,
      fallback_policy = excluded.fallback_policy,
      output_format = excluded.output_format,
      transcode_policy = excluded.transcode_policy,
      updated_at = CURRENT_TIMESTAMP
  `);

  // Shared stereo ladder. Only cutoff / continue_upgrades / output_format differ.
  const stereoAllowed = JSON.stringify(["hires-lossless", "lossless", "lossy"]);
  const stereoPreference = JSON.stringify(["hires-lossless", "lossless", "lossy"]);

  // Max — preferred maximum is hi-res; keep ranking every rung above cutoff.
  upsert.run(
    "Max Quality",
    1,
    "hires-lossless",
    JSON.stringify(["HIRES_LOSSLESS", "LOSSLESS"]),
    stereoAllowed,
    stereoPreference,
    1,
    "best_allowed",
    JSON.stringify({ codec: "preserve", lossless: true }),
    "preserve",
  );
  // High — preferred max = lossless (hi-res ≡ lossless for ranking; lossy worse).
  upsert.run(
    "High Quality",
    1,
    "lossless",
    JSON.stringify(["LOSSLESS"]),
    stereoAllowed,
    stereoPreference,
    0,
    "best_allowed",
    JSON.stringify({ codec: "flac", lossless: true, bitDepth: 16, sampleRate: 44100 }),
    "downconvert_hires",
  );
  // Normal — preferred max = lossy band: hi-res ≡ lossless ≡ lossy for ranking;
  // coverage / single-source / provider decide. Output still targets ~320k when converting.
  upsert.run(
    "Normal Quality",
    0,
    "lossy",
    JSON.stringify(["LOSSLESS"]),
    stereoAllowed,
    stereoPreference,
    0,
    "best_allowed",
    JSON.stringify({ codec: "mp3", lossless: false, bitrate: 320000 }),
    "transcode_allowed",
  );
  // Low — same equal band as Normal for ranking; smaller lossy output target.
  upsert.run(
    "Low Quality",
    0,
    "lossy",
    JSON.stringify(["HIRES_LOSSLESS", "LOSSLESS"]),
    stereoAllowed,
    stereoPreference,
    0,
    "best_allowed",
    JSON.stringify({ codec: "mp3", lossless: false, bitrate: 128000 }),
    "transcode_allowed",
  );
  upsert.run(
    "Spatial",
    1,
    "spatial",
    JSON.stringify([]),
    JSON.stringify(["spatial"]),
    JSON.stringify(["spatial"]),
    1,
    "unavailable",
    JSON.stringify({ spatial: true }),
    "preserve",
  );
  upsert.run(
    "Video",
    1,
    "video",
    JSON.stringify([]),
    JSON.stringify(["video"]),
    JSON.stringify(["video"]),
    0,
    "unavailable",
    JSON.stringify({ video: true }),
    "preserve",
  );
}

function profileIdByName(db: Database.Database, name: string): number | null {
  const row = db.prepare(`SELECT id FROM quality_profiles WHERE name = ? LIMIT 1`).get(name) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/**
 * Apply Settings quality + spatial toggle onto the fixed Stereo / Spatial libraries.
 *
 * Safe to call on every config write and after bootstrap. No-ops when libraries
 * have not been created yet.
 */
export function applyLibrarySettingsFromConfig(
  db: Database.Database,
  input: {
    audioQuality: StereoAudioQuality;
    includeSpatial: boolean;
  },
): {
  stereoProfileId: number | null;
  stereoProfileName: string;
  spatialEnabled: boolean;
} {
  ensureDefaultQualityProfiles(db);

  const stereoProfileName = stereoQualityProfileName(input.audioQuality);
  const stereoProfileId = profileIdByName(db, stereoProfileName);
  const spatialProfileId = profileIdByName(db, "Spatial");

  if (stereoProfileId != null) {
    db.prepare(`
      UPDATE Libraries
      SET quality_profile_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `).run(stereoProfileId, STEREO_LIBRARY_NAME);
  }

  if (spatialProfileId != null) {
    // Spatial has no quality ladder — only provider preference later. The
    // Settings toggle solely decides whether Atmos planning is active.
    db.prepare(`
      UPDATE Libraries
      SET
        quality_profile_id = ?,
        enabled = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `).run(spatialProfileId, input.includeSpatial ? 1 : 0, SPATIAL_LIBRARY_NAME);
  }

  return {
    stereoProfileId,
    stereoProfileName,
    spatialEnabled: input.includeSpatial,
  };
}
