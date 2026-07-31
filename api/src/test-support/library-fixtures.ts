import type Database from "better-sqlite3";

export function seedTestLibrary(
  db: Database.Database,
  input: { name: string; rootPath: string },
): number {
  const profile = db.prepare(`
    SELECT
      (SELECT id FROM MetadataProfiles ORDER BY id LIMIT 1) AS metadataProfileId,
      (SELECT id FROM quality_profiles ORDER BY id LIMIT 1) AS qualityProfileId
  `).get() as {
    metadataProfileId: number | null;
    qualityProfileId: number | null;
  };

  if (profile.metadataProfileId === null || profile.qualityProfileId === null) {
    throw new Error("Active-schema test fixture is missing default library profiles");
  }

  const inserted = db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    ) VALUES (?, ?, ?, ?, 1)
    RETURNING id
  `).get(
    input.name,
    input.rootPath,
    profile.metadataProfileId,
    profile.qualityProfileId,
  ) as { id: number };
  return inserted.id;
}
