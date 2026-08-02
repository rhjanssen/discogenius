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

test("Max and High allow lossy as a fallback rung, not only lossless", () => {
  withDb((db) => {
    ensureDefaultQualityProfiles(db);
    const rows = db.prepare(`
      SELECT name, allowed_source_formats, preference_order, cutoff
      FROM quality_profiles
      WHERE name IN ('Max Quality', 'High Quality')
      ORDER BY name
    `).all() as Array<{
      name: string;
      allowed_source_formats: string;
      preference_order: string;
      cutoff: string;
    }>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const allowed = JSON.parse(row.allowed_source_formats) as string[];
      const preference = JSON.parse(row.preference_order) as string[];
      assert.ok(allowed.includes("lossy"), `${row.name} must allow lossy fallback`);
      assert.ok(allowed.includes("lossless"), `${row.name} must allow lossless`);
      assert.ok(preference.includes("lossy"), `${row.name} preference must rank lossy`);
      // Higher rungs first.
      assert.ok(
        preference.indexOf("lossless") < preference.indexOf("lossy"),
        `${row.name} must prefer lossless over lossy`,
      );
    }
    const max = rows.find((row) => row.name === "Max Quality")!;
    assert.equal(max.cutoff, "hires-lossless");
    assert.equal(
      (JSON.parse(max.preference_order) as string[])[0],
      "hires-lossless",
    );
  });
});
