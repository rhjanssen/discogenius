import type Database from "better-sqlite3";

export function createCommandFileWorkSchema(db: Database.Database, options: { ifNotExists?: boolean } = {}): void {
  const guard = options.ifNotExists ? "IF NOT EXISTS" : "";
  db.exec(`
    CREATE TABLE ${guard} CommandRenamePlans (
      command_id INTEGER PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE,
      config_revision TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      total INTEGER NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL,
      CHECK (cursor >= 0 AND cursor <= total)
    );
    CREATE TABLE ${guard} CommandRenameWork (
      command_id INTEGER NOT NULL REFERENCES CommandRenamePlans(command_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 1,
      ordinal INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      identity_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'settled')),
      result TEXT,
      PRIMARY KEY (command_id, generation, ordinal),
      UNIQUE (command_id, generation, file_id)
    );
    CREATE TABLE ${guard} FileMutationJournal (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL CHECK (table_name IN ('TrackFiles', 'MetadataFiles', 'ExtraFiles', 'LyricFiles')),
      row_id INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('move', 'delete')),
      phase TEXT NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared', 'committed')),
      source_path TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      temporary_path TEXT NOT NULL,
      source_stat TEXT NOT NULL,
      source_sha256 TEXT,
      row_snapshot TEXT NOT NULL,
      recovery_error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (table_name, row_id)
    );
    CREATE TABLE ${guard} LibraryCleanupJournal (
      id TEXT PRIMARY KEY,
      inventory_command_id INTEGER NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      staged_path TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      root_identity TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      review_id INTEGER,
      review_snapshot TEXT,
      phase TEXT NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','committed')),
      recovery_error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${guard} LibraryCleanupCandidates (
      inventory_command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      root_path TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('unowned', 'unresolved_sidecar', 'review_sidecar')),
      PRIMARY KEY (inventory_command_id, file_path)
    );
    CREATE TABLE ${guard} LibraryCleanupResults (
      inventory_command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      cleanup_command_id INTEGER REFERENCES commands(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('deleted','protected','refused')),
      reason TEXT NOT NULL,
      directory_witnesses TEXT NOT NULL DEFAULT '[]',
      prune_done INTEGER NOT NULL DEFAULT 1,
      pruned INTEGER NOT NULL DEFAULT 0,
      prune_error TEXT,
      PRIMARY KEY (inventory_command_id,file_path),
      FOREIGN KEY (inventory_command_id,file_path) REFERENCES LibraryCleanupCandidates(inventory_command_id,file_path) ON DELETE CASCADE
    );
    CREATE INDEX ${guard} idx_cleanup_results_pending_prune
      ON LibraryCleanupResults(cleanup_command_id,prune_done,file_path);
    CREATE TABLE ${guard} CommandFileWorkPlans (
      command_id INTEGER PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN ('retag', 'strip')),
      config_revision TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      total INTEGER NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      retagged INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      missing INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (cursor >= 0 AND cursor <= total)
    );
    CREATE TABLE ${guard} CommandFileWork (
      command_id INTEGER NOT NULL REFERENCES CommandFileWorkPlans(command_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      -- Historical operation identity survives removal of a TrackFiles row.
      track_file_id INTEGER NOT NULL,
      identity_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'settled')),
      intent_path TEXT,
      intent_size INTEGER,
      intent_modified_at TEXT,
      retagged INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      missing INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at DATETIME,
      settled_at DATETIME,
      PRIMARY KEY (command_id, generation, ordinal),
      UNIQUE (command_id, generation, track_file_id)
    );
  `);
}

export function createDownloadQueueSchema(
  db: Database.Database,
  options: { ifNotExists?: boolean } = {},
): void {
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS" : "";
  db.exec(`
    CREATE TABLE ${ifNotExists} DownloadQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Stable public queue id. Cancel / reorder / SSE jobId use this, not commands.id.
      ref_key TEXT NOT NULL,
      media_kind TEXT NOT NULL CHECK (media_kind IN ('album', 'track', 'video')),
      command_name TEXT NOT NULL,
      plan_id INTEGER,
      track_ids TEXT,
      provider TEXT,
      provider_id TEXT,
      artist_id TEXT,
      album_id TEXT,
      title TEXT,
      artist TEXT,
      cover TEXT,
      quality TEXT,
      slot TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      queue_order REAL NOT NULL,
      priority INT NOT NULL DEFAULT 0,
      trigger INT NOT NULL DEFAULT 0,
      command_id INTEGER,
      claimed_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX ${ifNotExists} idx_download_queue_typed_ref
    ON DownloadQueue(media_kind, ref_key, COALESCE(provider, ''), COALESCE(slot, ''))
  `);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_order ON DownloadQueue(queue_order, id)`);
  db.exec(`
    CREATE INDEX ${ifNotExists} idx_download_queue_unclaimed_order
    ON DownloadQueue(queue_order, id)
    WHERE command_id IS NULL
  `);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_command_id ON DownloadQueue(command_id)`);
  // Queue status groups all unclaimed names. Cover that aggregate without
  // reading thousands of large payload rows on the HTTP event loop.
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_unclaimed_names
    ON DownloadQueue(command_name) WHERE command_id IS NULL`);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_waiting_intent
    ON DownloadQueue(json_extract(payload, '$.libraryId'), json_extract(payload, '$.releaseMbid'),
      COALESCE(provider, json_extract(payload, '$.provider')))
    WHERE command_id IS NULL AND json_valid(payload)`);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_album_id ON DownloadQueue(album_id)`);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_artist_id ON DownloadQueue(artist_id)`);
  db.exec(`CREATE INDEX ${ifNotExists} idx_download_queue_provider_id ON DownloadQueue(provider_id)`);
}

export function createCommandsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal command ID
      name TEXT NOT NULL,               -- Command name (RefreshArtist, DownloadAlbum, etc.)
      ref_id TEXT,                      -- Optional reference id (Tidal ID, file id, etc)
      payload TEXT NOT NULL,            -- JSON data necessary for execution
      -- Indexed exact link for legacy/separate ImportDownload rows. Keeping the
      -- projection generated avoids a shadow writer while removing JSON scans
      -- from 100k-row history queries.
      original_job_id INTEGER GENERATED ALWAYS AS (
        CASE
          WHEN name = 'ImportDownload'
            THEN CAST(json_extract(payload, '$.originalJobId') AS INTEGER)
          ELSE NULL
        END
      ) STORED,
      status TEXT DEFAULT 'queued',     -- queued, started, completed, failed, cancelled
      progress INT DEFAULT 0,           -- 0-100
      priority INT DEFAULT 0,           -- higher = processed first
      trigger INT DEFAULT 0,            -- 0=Unspecified, 1=Manual, 2=Scheduled
      -- Authoritative sparse/fractional rank for queued downloads. Priority and
      -- trigger choose the initial insertion point; explicit user moves update
      -- only this rank and therefore remain durable.
      queue_order REAL,
      attempts INT DEFAULT 0,
      attempt INT NOT NULL DEFAULT 0,   -- durable execution-attempt number
      error TEXT,

      -- Non-download command execution lease. worker_id is an opaque,
      -- per-attempt ownership token rather than a reusable thread id.
      worker_id TEXT,
      heartbeat_at DATETIME,
      last_progress_at DATETIME,
      progress_phase TEXT,
      progress_current INT,
      progress_total INT,
      lease_expires_at DATETIME,
      blocked_reason TEXT,
      retry_after DATETIME,
      last_retry_reason TEXT,
      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  createDownloadQueueSchema(db);

  db.exec(`
    CREATE TABLE scheduled_tasks (
      task_key TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      interval_minutes INT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      last_queued_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE monitoring_runtime_state (
      state_key TEXT PRIMARY KEY,
      last_check_timestamp DATETIME,
      check_in_progress BOOLEAN NOT NULL DEFAULT 0,
      progress_artist_index INT NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE quality_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      upgrade_allowed BOOLEAN DEFAULT 1,
      cutoff TEXT NOT NULL,          -- 'LOSSLESS', 'HIRES_LOSSLESS', etc.
      items TEXT NOT NULL DEFAULT '[]', -- Legacy-compatible ordered quality labels
      allowed_source_formats TEXT,
      preference_order TEXT,
      continue_upgrades BOOLEAN NOT NULL DEFAULT 0,
      fallback_policy TEXT,
      output_format TEXT,
      transcode_policy TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE history_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT,
      album_id TEXT,
      media_id TEXT,
      library_file_id TEXT,
      event_type TEXT NOT NULL,
      quality TEXT,
      source_title TEXT,
      data TEXT,
      date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function createCommandsIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX idx_commands_status ON commands(status)`);
  db.exec(`CREATE INDEX idx_commands_name ON commands(name)`);
  db.exec(`CREATE INDEX idx_commands_ref_id ON commands(ref_id)`);
  db.exec(`CREATE INDEX idx_commands_original_job_id ON commands(name, original_job_id)`);
  db.exec(`CREATE INDEX idx_commands_priority ON commands(priority)`);
  db.exec(`CREATE INDEX idx_commands_queue_order ON commands(queue_order)`);
  db.exec(`
    CREATE UNIQUE INDEX idx_commands_live_download_queue_order
    ON commands(queue_order)
    WHERE status IN ('queued', 'started')
      AND name IN ('DownloadTrack', 'DownloadVideo', 'DownloadAlbum')
      AND queue_order IS NOT NULL
  `);
  db.exec(`CREATE INDEX idx_commands_status_priority ON commands(status, priority)`);
  db.exec(`CREATE INDEX idx_commands_name_status_ref_id ON commands(name, status, ref_id)`);
  db.exec(`CREATE INDEX idx_commands_status_name_created ON commands(status, name, created_at)`);
  db.exec(`CREATE INDEX idx_commands_status_name_started ON commands(status, name, started_at)`);
  db.exec(`CREATE INDEX idx_commands_status_name_completed ON commands(status, name, completed_at DESC, id DESC)`);
  db.exec(`CREATE INDEX idx_commands_status_lease ON commands(status, lease_expires_at)`);
  db.exec(`CREATE INDEX idx_commands_status_retry_after ON commands(status, retry_after)`);
  db.exec(`CREATE INDEX idx_commands_worker_id ON commands(worker_id)`);
  db.exec(`CREATE INDEX idx_commands_poll ON commands(status, priority DESC, trigger, queue_order ASC, created_at ASC)`);
  db.exec(`
    CREATE INDEX idx_commands_download_queue
    ON commands(status, queue_order ASC, created_at ASC, id ASC)
    WHERE name IN ('DownloadTrack', 'DownloadVideo', 'DownloadAlbum')
  `);
  db.exec(`CREATE INDEX idx_commands_queue_view ON commands(name, status, priority, trigger, queue_order, created_at, started_at, updated_at, id)`);
  db.exec(`CREATE INDEX idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`);
  db.exec("CREATE INDEX idx_history_events_date ON history_events(date DESC)");
  db.exec("CREATE INDEX idx_history_events_artist ON history_events(artist_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_album ON history_events(album_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_media ON history_events(media_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_event_type ON history_events(event_type, date DESC)");
}
