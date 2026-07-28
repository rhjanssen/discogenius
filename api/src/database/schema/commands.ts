import type Database from "better-sqlite3";

export function createCommandsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal command ID
      name TEXT NOT NULL,               -- Command name (RefreshArtist, DownloadAlbum, etc.)
      ref_id TEXT,                      -- Optional reference id (Tidal ID, file id, etc)
      payload TEXT NOT NULL,            -- JSON data necessary for execution
      status TEXT DEFAULT 'queued',     -- queued, started, completed, failed, cancelled
      progress INT DEFAULT 0,           -- 0-100
      priority INT DEFAULT 0,           -- higher = processed first
      trigger INT DEFAULT 0,            -- 0=Unspecified, 1=Manual, 2=Scheduled
      queue_order INT,
      attempts INT DEFAULT 0,
      error TEXT,
      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
  db.exec(`CREATE INDEX idx_commands_priority ON commands(priority)`);
  db.exec(`CREATE INDEX idx_commands_queue_order ON commands(queue_order)`);
  db.exec(`CREATE INDEX idx_commands_status_priority ON commands(status, priority)`);
  db.exec(`CREATE INDEX idx_commands_name_status_ref_id ON commands(name, status, ref_id)`);
  db.exec(`CREATE INDEX idx_commands_status_name_created ON commands(status, name, created_at)`);
  db.exec(`CREATE INDEX idx_commands_status_name_started ON commands(status, name, started_at)`);
  db.exec(`CREATE INDEX idx_commands_status_name_completed ON commands(status, name, completed_at DESC, id DESC)`);
  db.exec(`CREATE INDEX idx_commands_poll ON commands(status, priority DESC, trigger DESC, queue_order ASC, created_at ASC)`);
  db.exec(`CREATE INDEX idx_commands_queue_view ON commands(name, status, priority, trigger, queue_order, created_at, started_at, updated_at, id)`);
  db.exec(`CREATE INDEX idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`);
  db.exec("CREATE INDEX idx_history_events_date ON history_events(date DESC)");
  db.exec("CREATE INDEX idx_history_events_artist ON history_events(artist_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_album ON history_events(album_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_media ON history_events(media_id, date DESC)");
  db.exec("CREATE INDEX idx_history_events_event_type ON history_events(event_type, date DESC)");
}
