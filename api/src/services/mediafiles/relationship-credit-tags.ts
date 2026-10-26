import type { RecordingWorkLink, RelationshipCredit } from "../catalog/relationship-credit-model.js";
import { picardCreditTags, type PicardCreditTag } from "../catalog/relationship-credit-model.js";
import type { ManagedTag } from "./audio-tag-service.js";

/** Same joiner as MULTI_VALUE_SEPARATOR. Kept local to avoid a writer import cycle. */
const SEPARATOR = "; ";

const TIPL_ROLE: Record<string, string> = {
  engineer: "engineer",
  arranger: "arranger",
  producer: "producer",
  djmixer: "DJ-mix",
  mixer: "mix",
};

type TagFamily = "vorbis" | "id3" | "mp4";

export function creditTagFamily(extension: string): TagFamily | null {
  const dotted = String(extension || "").toLowerCase();
  const ext = dotted.startsWith(".") ? dotted : `.${dotted}`;
  if ([".flac", ".ogg", ".oga", ".opus"].includes(ext)) return "vorbis";
  if ([".mp3", ".aac", ".wav", ".aif", ".aiff"].includes(ext)) return "id3";
  if ([".m4a", ".mp4"].includes(ext)) return "mp4";
  return null;
}

function managed(key: string, ffmpegKey: string, value: string): ManagedTag {
  return { key, label: key, ffmpegKey, targetValue: value };
}

function valuesOf(tags: PicardCreditTag[], name: string): string[] {
  return tags.filter((item) => item.tag === name).map((item) => item.value);
}

/**
 * Picard file tags for one track. MP4 does not store performer. ID3 puts
 * producer, engineer, arranger, mixer, and DJ-mix on TIPL, and performers on
 * TMCL. Vorbis repeats PERFORMER as "Name (role)".
 */
export function relationshipManagedTags(input: {
  credits: RelationshipCredit[];
  works: RecordingWorkLink[];
  extension: string;
  mediumPosition: number | null;
}): ManagedTag[] {
  const family = creditTagFamily(input.extension);
  if (!family) return [];
  const flat = picardCreditTags(input);
  const out: ManagedTag[] = [];
  const join = (key: string, ffmpegKey: string, tagName: string) => {
    const values = valuesOf(flat, tagName);
    if (values.length === 0) return;
    out.push(managed(key, ffmpegKey, values.join(SEPARATOR)));
  };
  join("composer", "COMPOSER", "composer");
  join("composer_sort", "COMPOSERSORT", "composersort");
  join("lyricist", "LYRICIST", "lyricist");
  join("writer", "WRITER", "writer");
  join("conductor", "CONDUCTOR", "conductor");
  join("remixer", "REMIXER", "remixer");
  join("work", "WORK", "work");
  join("musicbrainz_workid", "MUSICBRAINZ_WORKID", "musicbrainz_workid");
  join("musicbrainz_composerid", "MUSICBRAINZ_COMPOSERID", "musicbrainz_composerid");
  join("director", "DIRECTOR", "director");
  if (family === "id3") {
    const tipl: string[] = [];
    for (const item of flat) {
      const label = TIPL_ROLE[item.tag];
      if (label) tipl.push(label, item.value);
    }
    if (tipl.length > 0) out.push(managed("involved_people", "TIPL", tipl.join("\0")));
    const tmcl: string[] = [];
    for (const item of flat) {
      if (!item.tag.startsWith("performer:")) continue;
      tmcl.push(item.tag.slice("performer:".length), item.value);
    }
    if (tmcl.length > 0) out.push(managed("performer", "TMCL", tmcl.join("\0")));
    return out;
  }
  join("arranger", "ARRANGER", "arranger");
  join("producer", "PRODUCER", "producer");
  join("engineer", "ENGINEER", "engineer");
  join("mixer", "MIXER", "mixer");
  join("djmixer", "DJMIXER", "djmixer");
  if (family === "vorbis") {
    const performers: string[] = [];
    for (const item of flat) {
      if (!item.tag.startsWith("performer:")) continue;
      const role = item.tag.slice("performer:".length);
      performers.push(role ? `${item.value} (${role})` : item.value);
    }
    if (performers.length > 0) out.push(managed("performer", "PERFORMER", performers.join(SEPARATOR)));
  }
  return out;
}

/** File keys Picard writes. The logical name is not a removal key: Vorbis and
 * ID3 TXXX fold case, and MP4 maps "composer" onto ©wrt, so a retag that also
 * writes the credit would look like a failed removal. */
const CREDIT_FILE_KEY: Record<TagFamily, Record<string, string>> = {
  vorbis: {
    composer: "COMPOSER",
    composer_sort: "COMPOSERSORT",
    lyricist: "LYRICIST",
    writer: "WRITER",
    arranger: "ARRANGER",
    conductor: "CONDUCTOR",
    remixer: "REMIXER",
    producer: "PRODUCER",
    engineer: "ENGINEER",
    mixer: "MIXER",
    djmixer: "DJMIXER",
    performer: "PERFORMER",
    work: "WORK",
    musicbrainz_workid: "MUSICBRAINZ_WORKID",
    musicbrainz_composerid: "MUSICBRAINZ_COMPOSERID",
    director: "DIRECTOR",
  },
  id3: {
    composer: "TCOM",
    composer_sort: "TSOC",
    lyricist: "TEXT",
    writer: "TXXX:Writer",
    conductor: "TPE3",
    remixer: "TPE4",
    performer: "TMCL",
    involved_people: "TIPL",
    work: "TXXX:WORK",
    musicbrainz_workid: "TXXX:MusicBrainz Work Id",
    musicbrainz_composerid: "TXXX:MusicBrainz Composer Id",
    director: "TXXX:DIRECTOR",
  },
  mp4: {
    composer: "\u00a9wrt",
    composer_sort: "soco",
    lyricist: "----:com.apple.iTunes:LYRICIST",
    writer: "----:com.apple.iTunes:writer",
    arranger: "----:com.apple.iTunes:arranger",
    conductor: "----:com.apple.iTunes:CONDUCTOR",
    remixer: "----:com.apple.iTunes:REMIXER",
    producer: "----:com.apple.iTunes:PRODUCER",
    engineer: "----:com.apple.iTunes:ENGINEER",
    mixer: "----:com.apple.iTunes:MIXER",
    djmixer: "----:com.apple.iTunes:DJMIXER",
    work: "\u00a9wrk",
    musicbrainz_workid: "----:com.apple.iTunes:MusicBrainz Work Id",
    musicbrainz_composerid: "----:com.apple.iTunes:MusicBrainz Composer Id",
    director: "\u00a9dir",
  },
};

export function relationshipCreditRemovalTags(extension: string): ManagedTag[] {
  const family = creditTagFamily(extension);
  if (!family) return [];
  const keys = family === "id3"
    ? ["composer", "composer_sort", "lyricist", "writer", "conductor", "remixer", "performer", "involved_people", "work", "musicbrainz_workid", "musicbrainz_composerid", "director"]
    : family === "mp4"
      ? ["composer", "composer_sort", "lyricist", "writer", "arranger", "conductor", "remixer", "producer", "engineer", "mixer", "djmixer", "work", "musicbrainz_workid", "musicbrainz_composerid", "director"]
      : ["composer", "composer_sort", "lyricist", "writer", "arranger", "conductor", "remixer", "producer", "engineer", "mixer", "djmixer", "performer", "work", "musicbrainz_workid", "musicbrainz_composerid", "director"];
  return keys.map((key) => {
    const ffmpegKey = CREDIT_FILE_KEY[family][key] ?? key;
    if (family !== "mp4") return managed(key, ffmpegKey, "");
    // A Vorbis-style freeform is a different atom from ©wrt / ©wrk / soco.
    // Skip names that only differ by case from the key we write.
    const aliases = [`----:com.apple.iTunes:${key}`, `----:com.apple.iTunes:${key.toUpperCase()}`]
      .filter((alias) => alias.toLowerCase() !== ffmpegKey.toLowerCase());
    return { key, label: key, ffmpegKey, targetValue: "", aliases };
  });
}
