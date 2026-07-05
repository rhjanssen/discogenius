/**
 * MusicBrainz-docker connection helpers. The user configures only a HOST (IP or
 * hostname, e.g. `192.168.1.100` or `musicbrainz.mydomain.com`); we derive the
 * Postgres DSN and the `/ws/2` search URL from the standard musicbrainz-docker
 * layout (creds + db name from `default/postgres.env`, web on :5000, db on :5432).
 * An optional `:port` on the host overrides the Postgres port for advanced setups;
 * the web server is always assumed at :5000.
 */

const MB_PG_USER = "musicbrainz";
const MB_PG_PASSWORD = "musicbrainz";
const MB_PG_PORT = 5432;
const MB_PG_DATABASE = "musicbrainz_db";
const MB_WEB_PORT = 5000;

/** Strip scheme/path/whitespace, leaving `host` or `host:port`. */
export function normalizeMbHost(input: string | null | undefined): string {
  let value = String(input ?? "").trim();
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol.startsWith("postgres")) {
      return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`.trim();
    }
    if (parsed.hostname) {
      return parsed.hostname.trim();
    }
  } catch {
    // Not a URL; treat it as a raw host[:postgresPort] value below.
  }

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme:// fallback
  value = value.split("/")[0].split("?")[0]; // path/query
  value = value.replace(/^[^@\s]+@/, ""); // user:pass@host from pasted DSNs
  return value.trim();
}

/** `host[:pgport]` → `postgresql://musicbrainz:musicbrainz@host:port/musicbrainz_db`. */
export function buildMbPostgresDsn(host: string | null | undefined): string {
  const normalized = normalizeMbHost(host) || "localhost";
  const hostPort = /:\d+$/.test(normalized) ? normalized : `${normalized}:${MB_PG_PORT}`;
  return `postgresql://${MB_PG_USER}:${MB_PG_PASSWORD}@${hostPort}/${MB_PG_DATABASE}`;
}

/** `host[:pgport]` → `http://host:5000/ws/2` (web port is fixed), or null if no host. */
export function buildMbSearchWebUrl(host: string | null | undefined): string | null {
  const normalized = normalizeMbHost(host);
  if (!normalized) return null;
  const hostname = normalized.replace(/:\d+$/, "");
  return `http://${hostname}:${MB_WEB_PORT}/ws/2`;
}
