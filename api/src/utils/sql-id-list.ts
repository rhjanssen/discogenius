/**
 * SQLite caps bound parameters (SQLITE_MAX_VARIABLE_NUMBER, 32766 in current
 * builds; 999 in older ones). Id lists sourced from the library (file ids,
 * artist ids, recording ids) can exceed that, so pass them as ONE JSON
 * parameter and expand server-side:
 *
 *   db.prepare(`... WHERE id IN ${SQL_JSON_LIST}`).all(jsonList(ids))
 */
export const SQL_JSON_LIST = "(SELECT value FROM json_each(?))";

export function jsonList(values: ReadonlyArray<string | number>): string {
  return JSON.stringify(values);
}
