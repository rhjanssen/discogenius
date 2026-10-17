import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// SQL_JSON_LIST binds exactly ONE parameter (a JSON array). Spreading the id
// array into the statement call instead of passing jsonList(ids) compiles but
// fails at runtime ("Too many parameter values were provided"). Scan every
// call site: the statement call that follows a SQL_JSON_LIST must not spread
// the raw ids; only an explicit params/args array may be spread.
const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(full);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [full] : [];
  });
}

test("every SQL_JSON_LIST call site binds jsonList(...) instead of spreading ids", () => {
  const offenders: string[] = [];
  let sites = 0;
  for (const file of sourceFiles(srcRoot)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("SQL_JSON_LIST") || file.endsWith(join("utils", "sql-id-list.ts"))) continue;
    for (const match of text.matchAll(/\$\{SQL_JSON_LIST\}/g)) {
      sites++;
      const after = text.slice(match.index!, match.index! + 2500);
      const call = after.match(/\.(?:all|get|run|iterate)\(([^)]*)\)/);
      const args = call?.[1] ?? "";
      const badSpread = [...args.matchAll(/\.\.\.\s*([A-Za-z_$][\w$.]*)/g)]
        .map((spread) => spread[1])
        .filter((name) => !/(params|args|bindings)$/i.test(name));
      if (badSpread.length) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(srcRoot, file)}:${line} spreads ${badSpread.join(", ")}`);
      }
    }
  }
  assert.ok(sites >= 10, `expected to scan the SQL_JSON_LIST call sites, found ${sites}`);
  assert.deepEqual(offenders, []);
});
