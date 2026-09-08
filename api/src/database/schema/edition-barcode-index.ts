import type Database from "better-sqlite3";

// Preserve the matcher's digit-only, leading-zero-insensitive UPC identity.
// SQLite owns this projection so every catalogue writer, including bulk imports,
// updates it in the same transaction without registering a connection-local UDF.
function normalizedBarcode(column: string): string {
  return `(WITH RECURSIVE digits(position, value) AS (
    VALUES (1, '')
    UNION ALL
    SELECT position + 1, value || CASE
      WHEN substr(${column}, position, 1) GLOB '[0-9]'
      THEN substr(${column}, position, 1) ELSE '' END
    FROM digits WHERE position <= length(${column})
  ) SELECT CASE WHEN value = '' THEN NULL
    ELSE COALESCE(NULLIF(ltrim(value, '0'), ''), '0') END
    FROM digits ORDER BY position DESC LIMIT 1)`;
}

export function ensureEditionBarcodeIndex(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'EditionBarcodeIndex'").get()) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE EditionBarcodeIndex (
        edition_id INTEGER PRIMARY KEY REFERENCES AlbumEditions(id) ON DELETE CASCADE,
        barcode TEXT
      );
      CREATE INDEX idx_edition_barcode_value ON EditionBarcodeIndex(barcode);
      INSERT INTO EditionBarcodeIndex (edition_id, barcode)
        SELECT edition.id, ${normalizedBarcode('edition.barcode')}
        FROM AlbumEditions edition WHERE edition.barcode IS NOT NULL;
      CREATE TRIGGER edition_barcode_insert AFTER INSERT ON AlbumEditions
      WHEN NEW.barcode IS NOT NULL BEGIN
        INSERT INTO EditionBarcodeIndex (edition_id, barcode)
          VALUES (NEW.id, ${normalizedBarcode('NEW.barcode')});
      END;
      CREATE TRIGGER edition_barcode_update AFTER UPDATE OF barcode ON AlbumEditions
      WHEN OLD.barcode IS NOT NEW.barcode BEGIN
        INSERT INTO EditionBarcodeIndex (edition_id, barcode)
          VALUES (NEW.id, ${normalizedBarcode('NEW.barcode')})
          ON CONFLICT(edition_id) DO UPDATE SET barcode = excluded.barcode;
      END;
    `);
  })();
}
