/**
 * MusicBrainz artist relationships, mapped the way Picard maps them with
 * track relationships and release relationships on. Mastering is stored and
 * not written: current Picard leaves that link type commented out.
 * translate_artist_names stays off, so a credited-as name does not pick an
 * alias sort name; composersort uses the artist sort name.
 */

export type CreditScope = "recording" | "release" | "work";

export type RelationshipCredit = {
  scope: CreditScope;
  /** Recording MBID, release MBID, or work MBID, depending on scope. */
  entityMbid: string;
  role: string;
  /** Instrument or vocal phrase for performer. Empty for other roles. */
  attribute: string;
  artistMbid: string;
  creditedName: string;
  sortName: string | null;
  order: number;
  /** mix-DJ medium. Null applies the credit to every track. */
  mediumPosition: number | null;
};

export type RecordingWorkLink = {
  recordingMbid: string;
  workMbid: string;
  title: string;
  order: number;
  instrumental: boolean;
};

/** Null means the provider did not supply relationships. Do not delete. */
export type RelationshipBundle = {
  queriedRecordingMbids: string[];
  queriedReleaseMbids: string[];
  credits: RelationshipCredit[];
  works: RecordingWorkLink[];
};

export type MbArtistRelationRow = {
  entity_mbid: string;
  link_id: number;
  link_order: number;
  link_type: string;
  artist_mbid: string;
  credited_name: string;
  sort_name: string | null;
  attribute_name: string | null;
  attribute_credit: string | null;
};

const PREFIX_ATTRS = new Set(["guest", "additional", "minor", "solo"]);
const BLANK_SPECIAL: Record<string, string> = { instrument: "instruments", vocal: "vocals" };

/** Picard's `_ARTIST_REL_TYPES`, plus mastering stored under its own role. */
export const ARTIST_REL_TYPES: Record<string, string> = {
  arranger: "arranger",
  audio: "engineer",
  "chorus master": "performer:chorus master",
  composer: "composer",
  concertmaster: "performer:concertmaster",
  conductor: "conductor",
  engineer: "engineer",
  "instrument arranger": "arranger",
  librettist: "lyricist",
  "live sound": "engineer",
  lyricist: "lyricist",
  mastering: "mastering",
  "mix-DJ": "djmixer",
  mix: "mixer",
  orchestrator: "arranger",
  "performing orchestra": "performer:orchestra",
  producer: "producer",
  remixer: "remixer",
  sound: "engineer",
  "audio director": "director",
  "video director": "director",
  "vocal arranger": "arranger",
  writer: "writer",
};

const WRITTEN_ROLES = new Set([
  "arranger", "engineer", "composer", "conductor", "lyricist", "producer",
  "remixer", "mixer", "writer", "director", "djmixer", "performer",
]);

export function parseRelationshipAttributes(attrs: string[], reltype: string, credits: Record<string, string>): string {
  const prefixes: string[] = [];
  const nouns: string[] = [];
  for (const raw of attrs) {
    const attr = credits[raw] || raw;
    if (PREFIX_ATTRS.has(attr)) prefixes.push(attr);
    else nouns.push(attr);
  }
  let result = "";
  if (nouns.length > 1) result = `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
  else if (nouns.length === 1) result = nouns[0]!;
  else result = BLANK_SPECIAL[reltype] || "";
  const prefix = prefixes.join(" ");
  return [prefix, result].filter(Boolean).join(" ").trim();
}

function mbid(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function creditBase(row: MbArtistRelationRow, scope: CreditScope): Omit<RelationshipCredit, "role" | "attribute" | "mediumPosition"> {
  return {
    scope,
    entityMbid: mbid(row.entity_mbid),
    artistMbid: mbid(row.artist_mbid),
    creditedName: row.credited_name,
    sortName: row.sort_name?.trim() || null,
    order: row.link_order,
  };
}

export function creditsFromRelationRows(scope: CreditScope, rows: MbArtistRelationRow[]): RelationshipCredit[] {
  const groups = new Map<string, MbArtistRelationRow[]>();
  for (const row of rows) {
    const key = `${row.entity_mbid}\0${row.link_id}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const credits: RelationshipCredit[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const attrs: string[] = [];
    const attrCredits: Record<string, string> = {};
    for (const row of list) {
      if (!row.attribute_name) continue;
      if (!attrs.includes(row.attribute_name)) attrs.push(row.attribute_name);
      if (row.attribute_credit) attrCredits[row.attribute_name] = row.attribute_credit;
    }
    const reltype = first.link_type;
    if (reltype === "vocal" || reltype === "instrument" || reltype === "performer") {
      credits.push({
        ...creditBase(first, scope),
        role: "performer",
        attribute: parseRelationshipAttributes(attrs, reltype, attrCredits),
        mediumPosition: null,
      });
      continue;
    }
    if (reltype === "mix-DJ" && attrs.length > 0) {
      for (const attr of attrs) {
        if (!attr.startsWith("medium")) continue;
        const medium = Number.parseInt(attr.split(/\s+/)[1] || "", 10);
        if (!Number.isInteger(medium)) continue;
        credits.push({
          ...creditBase(first, scope),
          role: "djmixer",
          attribute: "",
          mediumPosition: medium,
        });
      }
      continue;
    }
    const mapped = ARTIST_REL_TYPES[reltype];
    if (!mapped) continue;
    if (mapped.startsWith("performer:")) {
      credits.push({
        ...creditBase(first, scope),
        role: "performer",
        attribute: mapped.slice("performer:".length),
        mediumPosition: null,
      });
      continue;
    }
    credits.push({
      ...creditBase(first, scope),
      role: mapped,
      attribute: "",
      mediumPosition: null,
    });
  }
  return credits;
}

export type PicardCreditTag = { tag: string; value: string };

function addUnique(bucket: Map<string, string[]>, tag: string, value: string | null | undefined): void {
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  const list = bucket.get(tag) ?? [];
  if (!list.includes(trimmed)) {
    list.push(trimmed);
    bucket.set(tag, list);
  }
}

function considerCredit(bucket: Map<string, string[]>, credit: RelationshipCredit, instrumental: boolean): void {
  if (!WRITTEN_ROLES.has(credit.role)) return;
  if (instrumental && credit.role === "lyricist") return;
  if (credit.role === "performer") {
    addUnique(bucket, `performer:${credit.attribute}`, credit.creditedName);
    return;
  }
  addUnique(bucket, credit.role, credit.creditedName);
  if (credit.role === "composer") {
    addUnique(bucket, "composersort", credit.sortName || credit.creditedName);
    addUnique(bucket, "musicbrainz_composerid", credit.artistMbid);
  }
}

/**
 * Release credits, then recording credits, then each work. Duplicate values
 * for one tag are skipped. Work language is not copied onto LANGUAGE: that
 * tag stays the release language. Instrumental works skip their lyricist.
 */
export function picardCreditTags(input: {
  credits: RelationshipCredit[];
  works: RecordingWorkLink[];
  mediumPosition: number | null;
}): PicardCreditTag[] {
  const bucket = new Map<string, string[]>();
  const applies = (credit: RelationshipCredit): boolean =>
    credit.mediumPosition == null || credit.mediumPosition === input.mediumPosition;
  const ordered = (scope: CreditScope, entityMbid?: string) => input.credits
    .filter((credit) => credit.scope === scope && (entityMbid == null || credit.entityMbid === entityMbid))
    .filter(applies)
    .slice()
    .sort((a, b) => a.order - b.order || a.creditedName.localeCompare(b.creditedName));
  for (const credit of ordered("release")) considerCredit(bucket, credit, false);
  for (const credit of ordered("recording")) considerCredit(bucket, credit, false);
  const works = input.works.slice().sort((a, b) => a.order - b.order || a.workMbid.localeCompare(b.workMbid));
  for (const work of works) {
    addUnique(bucket, "work", work.title);
    addUnique(bucket, "musicbrainz_workid", work.workMbid);
    for (const credit of ordered("work", work.workMbid)) considerCredit(bucket, credit, work.instrumental);
  }
  return [...bucket.entries()].flatMap(([tag, values]) => values.map((value) => ({ tag, value })));
}
