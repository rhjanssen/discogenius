import { db, isDatabaseOpen } from "../../database.js";
import { getConfigSection } from "../config/config.js";

/**
 * "Translate artist names to locale" (Picard semantics).
 *
 * For each artist the first locale in the user's list that has a usable
 * MusicBrainz alias wins. Within a locale, an exact locale match ("en") beats
 * a regional one ("en_GB"), the alias marked primary for that locale beats
 * the rest, and "Artist name" beats "Legal name"; "Search hint" aliases are
 * never used. The alias' sort name comes along with it. Names that are already
 * written in Latin script stay as they are when skipLatin is set (Picard's
 * "ignore if the name is already in Latin script"), so only names like
 * "Пётр Ильич Чайковский" or "坂本龍一" are translated.
 *
 * One resolver: folders, file-name tokens, tags, and UI display all use
 * resolveArtistDisplayName so ALBUMARTIST matches the artist folder. ArtistMetadata
 * keeps the MusicBrainz name; only the display spelling changes.
 */

export type ArtistLocaleAlias = {
  name: string;
  sortName: string | null;
  locale: string;
  primaryForLocale: boolean;
  type: string | null;
};

export type ArtistNameTranslationOptions = {
  enabled: boolean;
  locales: string[];
  skipLatin: boolean;
};

export type TranslatedArtistName = { name: string; sortName: string | null; translated: boolean };

const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** True when every letter in the name is Latin script (digits, punctuation and symbols are ignored). */
export function isLatinScript(name: string): boolean {
  const letters = String(name || "").match(LETTER) ?? [];
  return letters.every((letter) => LATIN_LETTER.test(letter));
}

export function normalizeLocaleList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const locale = String(entry ?? "").trim().replace("-", "_").toLowerCase();
    if (!/^[a-z]{2,3}(_[a-z0-9]{2,8})?$/.test(locale) || seen.has(locale)) continue;
    seen.add(locale);
    result.push(locale);
  }
  return result;
}

function aliasRank(alias: ArtistLocaleAlias, wanted: string): number | null {
  const locale = String(alias.locale || "").trim().replace("-", "_").toLowerCase();
  if (!locale || !alias.name.trim()) return null;
  if (String(alias.type || "").toLowerCase() === "search hint") return null;
  const wantedLanguage = wanted.split("_")[0];
  let rank: number;
  if (locale === wanted) rank = 0;
  else if (locale.split("_")[0] === wantedLanguage) rank = 4;
  else return null;
  if (!alias.primaryForLocale) rank += 2;
  if (String(alias.type || "").toLowerCase() === "legal name") rank += 1;
  return rank;
}

/** The alias to use for these locales, or null to keep the MusicBrainz name. */
export function chooseLocaleAlias(aliases: ArtistLocaleAlias[], locales: string[]): ArtistLocaleAlias | null {
  for (const wanted of normalizeLocaleList(locales)) {
    let best: { alias: ArtistLocaleAlias; rank: number } | null = null;
    for (const alias of aliases) {
      const rank = aliasRank(alias, wanted);
      if (rank === null) continue;
      if (!best || rank < best.rank) best = { alias, rank };
    }
    if (best) return best.alias;
  }
  return null;
}

export function translateArtistName(
  name: string,
  sortName: string | null,
  aliases: ArtistLocaleAlias[],
  options: ArtistNameTranslationOptions,
): TranslatedArtistName {
  const unchanged = { name, sortName, translated: false };
  if (!options.enabled || !name || aliases.length === 0) return unchanged;
  if (options.skipLatin && isLatinScript(name)) return unchanged;
  const alias = chooseLocaleAlias(aliases, options.locales);
  if (!alias) return unchanged;
  const translatedName = alias.name.trim();
  return {
    name: translatedName,
    sortName: alias.sortName?.trim() || sortName,
    translated: translatedName !== name || (alias.sortName?.trim() || sortName) !== sortName,
  };
}

export type ArtistNameTranslationConfig = {
  translate_artist_names?: boolean;
  artist_name_locales?: string;
  translate_artist_names_skip_latin?: boolean;
};

/** Artist-name translation settings (metadata.translate_artist_names*). */
export function getArtistNameTranslationOptions(config?: ArtistNameTranslationConfig): ArtistNameTranslationOptions {
  const metadata = (config ?? getConfigSection("metadata")) as ArtistNameTranslationConfig;
  return {
    enabled: metadata.translate_artist_names === true,
    locales: normalizeLocaleList(metadata.artist_name_locales ?? "en,nl"),
    skipLatin: metadata.translate_artist_names_skip_latin !== false,
  };
}

/** Stored locale aliases of one artist (ArtistLocaleAliases). */
export function readArtistLocaleAliases(artistMbid: string): ArtistLocaleAlias[] {
  const mbid = String(artistMbid || "").trim().toLowerCase();
  if (!mbid || !isDatabaseOpen()) return [];
  try {
    const rows = db.prepare(`
      SELECT name, sort_name, locale, primary_for_locale, alias_type
      FROM ArtistLocaleAliases WHERE artist_mbid = ? ORDER BY ordinal
    `).all(mbid) as Array<{ name: string; sort_name: string | null; locale: string; primary_for_locale: number; alias_type: string | null }>;
    return rows.map((row) => ({
      name: row.name,
      sortName: row.sort_name,
      locale: row.locale,
      primaryForLocale: row.primary_for_locale === 1,
      type: row.alias_type,
    }));
  } catch {
    return [];
  }
}

/** Translate one artist from the stored aliases. */
export function translateStoredArtistName(
  artistMbid: string | null | undefined,
  name: string,
  sortName: string | null,
  options: ArtistNameTranslationOptions,
): TranslatedArtistName {
  if (!options.enabled || !artistMbid || !name) return { name, sortName, translated: false };
  if (options.skipLatin && isLatinScript(name)) return { name, sortName, translated: false };
  return translateArtistName(name, sortName, readArtistLocaleAliases(artistMbid), options);
}

/** Display spelling for folders, file tokens, tags, and UI. */
export function resolveArtistDisplayName(
  artistMbid: string | null | undefined,
  name: string,
  sortName: string | null = null,
  config?: ArtistNameTranslationConfig,
): string {
  const resolved = String(name || "").trim() || "Unknown Artist";
  return translateStoredArtistName(artistMbid, resolved, sortName, getArtistNameTranslationOptions(config)).name;
}
