import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  applyLibrarySettingsFromConfig,
  ensureDefaultQualityProfiles,
  stereoQualityProfileName,
} from "./library-settings-sync.js";
import { LibraryCurationRepository } from "./library-curation-repository.js";

/** Minimal tables for bootstrap + settings sync (no full production schema). */
function createMinimalLibraryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE quality_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      upgrade_allowed BOOLEAN DEFAULT 1,
      cutoff TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      allowed_source_formats TEXT,
      preference_order TEXT,
      continue_upgrades BOOLEAN NOT NULL DEFAULT 0,
      fallback_policy TEXT,
      output_format TEXT,
      transcode_policy TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE MetadataProfiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      release_type_policy TEXT NOT NULL,
      explicit_policy TEXT NOT NULL DEFAULT 'allow',
      require_provider_availability BOOLEAN NOT NULL DEFAULT 1,
      redundancy_enabled BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE Libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      metadata_profile_id INTEGER NOT NULL,
      quality_profile_id INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(metadata_profile_id) REFERENCES MetadataProfiles(id),
      FOREIGN KEY(quality_profile_id) REFERENCES quality_profiles(id)
    );
  `);
}

function withDb(run: (db: Database.Database) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-settings-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createMinimalLibraryTables(db);
    run(db);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

test("audio_quality maps onto stereo profile names", () => {
  assert.equal(stereoQualityProfileName("max"), "Max Quality");
  assert.equal(stereoQualityProfileName("high"), "High Quality");
  assert.equal(stereoQualityProfileName("normal"), "Normal Quality");
  assert.equal(stereoQualityProfileName("low"), "Low Quality");
});

test("Settings max selects Max Quality for Stereo and can disable Spatial", () => {
  withDb((db) => {
    const repo = new LibraryCurationRepository(db);
    repo.bootstrapDefaultLibraries(
      {
        stereoRoot: "/library/stereo",
        spatialRoot: "/library/spatial",
        videoRoot: "/library/video",
      },
      { audioQuality: "max", includeSpatial: false },
    );

    const stereo = db.prepare(`
      SELECT library.name, profile.name AS profile_name, library.enabled
      FROM Libraries library
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      WHERE library.name = 'Stereo'
    `).get() as { name: string; profile_name: string; enabled: number };
    const spatial = db.prepare(`
      SELECT library.name, profile.name AS profile_name, library.enabled
      FROM Libraries library
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      WHERE library.name = 'Spatial'
    `).get() as { name: string; profile_name: string; enabled: number };

    assert.equal(stereo.profile_name, "Max Quality");
    assert.equal(Number(stereo.enabled), 1);
    assert.equal(spatial.profile_name, "Spatial");
    assert.equal(Number(spatial.enabled), 0);
  });
});

test("changing Settings updates Stereo profile and Spatial enabled without path rewrite", () => {
  withDb((db) => {
    const repo = new LibraryCurationRepository(db);
    repo.bootstrapDefaultLibraries(
      {
        stereoRoot: "/library/stereo",
        spatialRoot: "/library/spatial",
        videoRoot: "/library/video",
      },
      { audioQuality: "high", includeSpatial: false },
    );

    applyLibrarySettingsFromConfig(db, { audioQuality: "max", includeSpatial: true });

    const stereo = db.prepare(`
      SELECT profile.name AS profile_name
      FROM Libraries library
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      WHERE library.name = 'Stereo'
    `).get() as { profile_name: string };
    const spatial = db.prepare(`
      SELECT enabled FROM Libraries WHERE name = 'Spatial'
    `).get() as { enabled: number };

    assert.equal(stereo.profile_name, "Max Quality");
    assert.equal(Number(spatial.enabled), 1);

    // Re-bootstrap paths only: must not stomp Max → High.
    repo.bootstrapDefaultLibraries(
      {
        stereoRoot: "/library/stereo-new",
        spatialRoot: "/library/spatial-new",
        videoRoot: "/library/video-new",
      },
      { audioQuality: "max", includeSpatial: true },
    );
    const after = db.prepare(`
      SELECT library.root_path, profile.name AS profile_name
      FROM Libraries library
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      WHERE library.name = 'Stereo'
    `).get() as { root_path: string; profile_name: string };
    assert.equal(after.profile_name, "Max Quality");
    assert.equal(after.root_path, "/library/stereo-new");
  });
});

test("ensureDefaultQualityProfiles is idempotent", () => {
  withDb((db) => {
    ensureDefaultQualityProfiles(db);
    ensureDefaultQualityProfiles(db);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM quality_profiles`).get() as { c: number }).c;
    assert.equal(count, 6);
  });
});

test("all stereo profiles share one ladder; only preferred max (cutoff) differs", () => {
  withDb((db) => {
    ensureDefaultQualityProfiles(db);
    const rows = db.prepare(`
      SELECT name, allowed_source_formats, preference_order, cutoff
      FROM quality_profiles
      WHERE name IN ('Max Quality', 'High Quality', 'Normal Quality', 'Low Quality')
      ORDER BY name
    `).all() as Array<{
      name: string;
      allowed_source_formats: string;
      preference_order: string;
      cutoff: string;
    }>;
    assert.equal(rows.length, 4);
    const sharedAllowed = '["hires-lossless","lossless","lossy"]';
    const sharedPreference = '["hires-lossless","lossless","lossy"]';
    for (const row of rows) {
      assert.equal(row.allowed_source_formats, sharedAllowed, `${row.name} allowlist`);
      assert.equal(row.preference_order, sharedPreference, `${row.name} preference`);
    }
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    assert.equal(byName["Max Quality"].cutoff, "hires-lossless");
    assert.equal(byName["High Quality"].cutoff, "lossless");
    // Normal/Low: cutoff at lossy so Max/High/Normal tiers share one ranking band.
    assert.equal(byName["Normal Quality"].cutoff, "lossy");
    assert.equal(byName["Low Quality"].cutoff, "lossy");
  });
});
