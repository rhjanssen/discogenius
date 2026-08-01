import { db } from "../../database.js";

const DOWNLOAD_QUEUE_PAUSED_KEY = "download_queue_paused";

export interface DownloadQueueControlState {
  isPaused: boolean;
  persisted: boolean;
  updatedAt: string | null;
}

function startupPauseDefault(): boolean {
  return process.env.DISCOGENIUS_START_PAUSED === "1";
}

function parsePersistedBoolean(value: unknown): boolean | null {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

/**
 * Read the authoritative download pause state.
 *
 * DISCOGENIUS_START_PAUSED is only a first-start default. Once an operator has
 * paused or resumed the queue, the persisted row wins on every later restart.
 */
export function getDownloadQueueControlState(): DownloadQueueControlState {
  let row: { value: string; updated_at: string } | undefined;
  try {
    row = db.prepare(`
      SELECT value, updated_at
      FROM runtime_controls
      WHERE control_key = ?
    `).get(DOWNLOAD_QUEUE_PAUSED_KEY) as { value: string; updated_at: string } | undefined;
  } catch (error) {
    // Bootstrap diagnostics can run before schema creation. The first-start
    // default is the only state available at that point; writes still fail
    // loudly until initDatabase has created the control plane.
    if (error instanceof Error && /no such table:\s*runtime_controls/i.test(error.message)) {
      row = undefined;
    } else {
      throw error;
    }
  }

  const persistedValue = parsePersistedBoolean(row?.value);
  if (persistedValue !== null) {
    return {
      isPaused: persistedValue,
      persisted: true,
      updatedAt: row?.updated_at ?? null,
    };
  }

  return {
    isPaused: startupPauseDefault(),
    persisted: false,
    updatedAt: null,
  };
}

/**
 * Persist before changing worker state so a process failure cannot acknowledge
 * a pause/resume that is immediately forgotten on restart.
 */
export function setDownloadQueuePaused(isPaused: boolean): DownloadQueueControlState {
  db.prepare(`
    INSERT INTO runtime_controls (control_key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(control_key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(DOWNLOAD_QUEUE_PAUSED_KEY, isPaused ? "true" : "false");

  return getDownloadQueueControlState();
}
