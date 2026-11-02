import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { SQL_JSON_LIST, jsonList } from "./sql-id-list.js";

test("json id list binds one parameter for more ids than SQLite's variable limit", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO t (id, name) VALUES (?, ?)");
  db.transaction(() => { for (let i = 1; i <= 40000; i++) insert.run(i, `n${i}`); })();
  const ids = Array.from({ length: 33500 }, (_, i) => i + 1);
  assert.throws(() => db.prepare(`SELECT COUNT(*) AS c FROM t WHERE id IN (${ids.map(() => "?").join(",")})`).get(...ids), /too many SQL variables/);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM t WHERE id IN ${SQL_JSON_LIST}`).get(jsonList(ids)) as { c: number };
  assert.equal(row.c, 33500);
  const text = db.prepare(`SELECT COUNT(*) AS c FROM t WHERE name IN ${SQL_JSON_LIST} OR CAST(id AS TEXT) IN ${SQL_JSON_LIST}`).get(jsonList(["n1", "n2"]), jsonList(["3"])) as { c: number };
  assert.equal(text.c, 3);
});
