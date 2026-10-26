import { mediaRewritePath, replaceMediaFile } from "./media-file-rewrite.js";
import { withMediaFileLock } from "./media-file-lock.js";
import {
  armInPlaceUndo,
  discardInPlaceUndo,
  fsyncMediaFile,
  isInPlaceTagCrash,
  markInPlaceUndoVerified,
  noteInPlaceWriteFinished,
  restoreInPlaceUndo,
  type ArmedUndo,
} from "./in-place-tag-undo.js";
import { parseRecordingIsrcs } from "../music/recording-coverage-units.js";
import fs from "node:fs";
import path from "node:path";
import {
  ByteVector,
  File as TagLibFile,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2Tag,
  Id3v2UserTextInformationFrame,
  Id3v2UniqueFileIdentifierFrame,
  Mpeg4AppleTag,
  Mpeg4AppleDataBoxFlagType,
  Picture,
  PictureType,
  ReadStyle,
  StringType,
  TagTypes,
  XiphComment,
} from "node-taglib-sharp";

const TAGLIB_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const ID3_EXTENSIONS = new Set([".aac", ".aif", ".aiff", ".mp3", ".wav"]);

const XIPH_EXTENSIONS = new Set([".flac", ".oga", ".ogg", ".opus"]);
const MP4_EXTENSIONS = new Set([".m4a", ".mp4"]);

const ID3_TEXT_KEYS: Record<string, string> = {
  title: "TIT2",
  artist: "TPE1",
  album_artist: "TPE2",
  album: "TALB",
  track: "TRCK",
  disc: "TPOS",
  date: "TDRC",
  original_date: "TDOR",
  tdor: "TDOR",
  tory: "TORY",
  genre: "TCON",
  tcmp: "TCMP",
  tsop: "TSOP",
  tso2: "TSO2",
  tsoc: "TSOC",
  tcom: "TCOM",
  text: "TEXT",
  tpe3: "TPE3",
  tpe4: "TPE4",
  isrc: "TSRC",
  copyright: "TCOP",
  publisher: "TPUB",
  tpub: "TPUB",
  label: "TPUB",
  tmed: "TMED",
  tkey: "TKEY",
  language: "TLAN",
  tlan: "TLAN",
  discsubtitle: "TSST",
  tsst: "TSST",
};

const MP4_TEXT_KEYS: Record<string, string> = {
  title: "\xa9nam",
  artist: "\xa9ART",
  album_artist: "aART",
  album: "\xa9alb",
  date: "\xa9day",
  year: "\xa9day",
  comment: "\xa9cmt",
  copyright: "cprt",
  genre: "\xa9gen",
  soar: "soar",
  soaa: "soaa",
  soal: "soal",
  sonm: "sonm",
  soco: "soco",
  "\xa9pub": "\xa9pub",
  composer: "\xa9wrt",
  lyrics: "\xa9lyr",
  "lyrics-eng": "\xa9lyr",
  isrc: "isrc",
};

function isArtistIdList(key: string): boolean {
  return /musicbrainz(?:album)?artistid$/i.test(key.replace(/[^a-z0-9]/gi, ""));
}

/** One Vorbis field / ID3v2.4 text value / MP4 data atom per item. */
const MULTI_VALUE_FIELD_NAMES = new Set([
  "artists", "albumartists", "discogenius_albumartist_mbids",
  "genre", "tcon", "\xa9gen", "releasetype", "musicbrainz album type",
  "label", "publisher", "tpub", "catalognumber",
]);
const SLASH_LIST_FIELD_NAMES = new Set(["genre", "tcon", "\xa9gen", "releasetype", "musicbrainz album type"]);

function multiValueFieldName(key: string): string {
  return key.replace(/^(txxx:|----:com\.apple\.itunes:)/i, "").toLowerCase();
}

/** Picard writes these as one Vorbis field / ID3v2.4 string / MP4 data atom per value. */
function isMultiValueList(key: string): boolean {
  return MULTI_VALUE_FIELD_NAMES.has(multiValueFieldName(key));
}

function tagValues(key: string, value: string): string[] {
  if (key.toLowerCase() === "isrc") return parseRecordingIsrcs(value);
  if (isArtistIdList(key)) return [...new Set(value.split(/[;,/\s]+/).filter(Boolean))];
  if (isMultiValueList(key)) {
    // Genre/release type never contain "/" legitimately; ID3v2.3 joins them with it.
    const separator = SLASH_LIST_FIELD_NAMES.has(multiValueFieldName(key)) ? /\s*[;/]\s*/ : /\s*;\s*/;
    return value.split(separator).map(item => item.trim()).filter(Boolean);
  }
  return value ? [value] : [];
}

/** Native fields produced by a write key. Used by audio and video cleanup. */
export function nativeMediaTagKeys(rawKey: string, extension: string): string[] {
  const ext = extension.toLowerCase().replace(/^\./, "");
  const lower = rawKey.toLowerCase();
  if (["flac", "ogg", "oga", "opus"].includes(ext)) return [rawKey.toUpperCase()];
  if (["mp3", "aac", "wav", "aif", "aiff"].includes(ext)) {
    if (["date", "year"].includes(lower)) return ["TDRC", "TYER", "TDAT", "TIME"];
    if (["original_date", "tdor"].includes(lower)) return ["TDOR", "TORY"];
    if (["lyrics", "lyrics-eng", "unsyncedlyrics"].includes(lower)) return ["USLT"];
    if (lower === "comment") return ["COMM"];
    return [ID3_TEXT_KEYS[lower] || (/^(TXXX:|UFID:)/i.test(rawKey) || rawKey.length === 4 ? rawKey : `TXXX:${rawKey}`)];
  }
  if (["m4a", "mp4", "m4v", "mov"].includes(ext)) {
    if (lower === "isrc") return ["----:com.apple.iTunes:ISRC"];
    if (lower === "track") return ["trkn"];
    if (lower === "disc") return ["disk"];
    return [MP4_TEXT_KEYS[lower] || (rawKey.startsWith("----:") || rawKey.length === 4 ? rawKey : `----:com.apple.iTunes:${rawKey}`)];
  }
  return [rawKey];
}

export type MediaTagWriteResult = {
  handled: boolean;
  success: boolean;
  backend?: "taglib";
  error?: string;
  /** True when the requested cover was written and verified in the same rewrite. */
  coverEmbedded?: boolean;
};

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

type Mp4AtomHeader = {
  type: string;
  size: number;
  headerSize: number;
};

function readMp4AtomHeader(
  fd: number,
  position: number,
  rangeEnd: number,
): Mp4AtomHeader | null {
  if (position + 8 > rangeEnd) return null;
  const header = Buffer.allocUnsafe(16);
  const bytesRead = fs.readSync(fd, header, 0, Math.min(16, rangeEnd - position), position);
  if (bytesRead < 8) return null;

  let size = header.readUInt32BE(0);
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = rangeEnd - position;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || position + size > rangeEnd) {
    return null;
  }
  return {
    type: header.toString("latin1", 4, 8),
    size,
    headerSize,
  };
}

/**
 * node-taglib-sharp's MPEG-4 writer supports iTunes-style `ilst` metadata but
 * corrupts FFmpeg's ISO `mdta` metadata layout (`meta` + `keys`). Detect that
 * layout without reading `mdat`; those files stay on the Mutagen backend.
 */
function hasMp4MetadataKeysAtom(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const fileSize = fs.fstatSync(fd).size;
    const containers = new Set(["moov", "udta", "meta"]);
    const walk = (start: number, end: number, depth: number): boolean => {
      if (depth > 8) return false;
      let position = start;
      while (position + 8 <= end) {
        const atom = readMp4AtomHeader(fd!, position, end);
        if (!atom) return false;
        if (atom.type === "keys") return true;
        if (containers.has(atom.type)) {
          const childStart = position + atom.headerSize + (atom.type === "meta" ? 4 : 0);
          if (childStart <= position + atom.size && walk(childStart, position + atom.size, depth + 1)) {
            return true;
          }
        }
        position += atom.size;
      }
      return false;
    };
    return walk(0, fileSize, 0);
  } catch {
    // An unreadable or structurally invalid MP4 is not safe to mutate with the
    // TagLib path; let the compatibility backend provide its own diagnostic.
    return true;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function canHandleWithTagLib(filePath: string): boolean {
  const extension = extensionOf(filePath);
  if (!TAGLIB_EXTENSIONS.has(extension)) return false;
  if (!MP4_EXTENSIONS.has(extension) || !fs.existsSync(filePath)) return true;
  return !hasMp4MetadataKeysAtom(filePath);
}

function normalizeTagValue(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function parseFraction(value: string): { current: number; total: number } {
  const [current, total] = String(value || "").split("/", 2);
  return {
    current: Math.max(0, Number.parseInt(current || "0", 10) || 0),
    total: Math.max(0, Number.parseInt(total || "0", 10) || 0),
  };
}

function mp4BoxType(value: string): ByteVector {
  return ByteVector.fromString(value, StringType.Latin1);
}

function withTagLibFile<T>(
  filePath: string,
  action: (file: TagLibFile) => T,
  readStyle: ReadStyle = ReadStyle.None,
): T {
  const file = TagLibFile.createFromPath(filePath, undefined, readStyle);
  try {
    return action(file);
  } finally {
    file.dispose();
  }
}

function userTextFrames(tag: Id3v2Tag): Id3v2UserTextInformationFrame[] {
  return tag.getFramesByClassType<Id3v2UserTextInformationFrame>(
    Id3v2FrameClassType.UserTextInformationFrame,
  );
}

function findUserTextFrame(
  tag: Id3v2Tag,
  description: string,
): Id3v2UserTextInformationFrame | undefined {
  return Id3v2UserTextInformationFrame.findUserTextInformationFrame(
    userTextFrames(tag),
    description,
    false,
  );
}

function setId3UserText(tag: Id3v2Tag, description: string, value: string): void {
  const existing = findUserTextFrame(tag, description);
  if (!value) {
    if (existing) tag.removeFrame(existing);
    return;
  }
  const frame = existing ?? Id3v2UserTextInformationFrame.fromDescription(description);
  const values = tagValues(description, value);
  // ID3v2.3 has no multi-value text; "/" is ambiguous for names like AC/DC.
  const v23Separator = isMultiValueList(description) && !SLASH_LIST_FIELD_NAMES.has(multiValueFieldName(description)) ? "; " : "/";
  frame.text = tag.version >= 4 ? values : [values.join(v23Separator)];
  if (!existing) tag.addFrame(frame);
}

function id3TextIdentifier(key: string) {
  const mapped = ID3_TEXT_KEYS[key.toLowerCase()];
  const lookupKey = mapped || key.toUpperCase();
  return lookupKey ? (Id3v2FrameIdentifiers as any)[lookupKey] : undefined;
}

function setId3Value(tag: Id3v2Tag, rawKey: string, value: string): void {
  if (rawKey.toLowerCase().startsWith("ufid:")) {
    const owner = rawKey.slice(5);
    const frames = tag.getFramesByClassType<Id3v2UniqueFileIdentifierFrame>(Id3v2FrameClassType.UniqueFileIdentifierFrame);
    for (const frame of frames) if (frame.owner === owner) tag.removeFrame(frame);
    if (owner === "http://musicbrainz.org") setId3UserText(tag, "MusicBrainz Track Id", "");
    if (value) tag.addFrame(Id3v2UniqueFileIdentifierFrame.fromData(owner, ByteVector.fromString(value, StringType.Latin1)));
    return;
  }
  if (["isrc", "tsrc"].includes(rawKey.toLowerCase())) {
    const values = parseRecordingIsrcs(value);
    // Picard writes separate text values in v2.4 and joins them in v2.3.
    tag.setTextFrame(Id3v2FrameIdentifiers.TSRC, ...(tag.version >= 4 ? values : [values.join("/")]));
    return;
  }
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  if (lower.startsWith("txxx:")) {
    setId3UserText(tag, key.slice(5), value);
    return;
  }
  if (lower === "lyrics-eng" || lower === "lyrics" || lower === "unsyncedlyrics") {
    tag.lyrics = value;
    return;
  }
  if (lower === "comment") {
    tag.comment = value;
    return;
  }
  if (lower === "date" || lower === "year") {
    if (tag.version >= 4) {
      tag.setTextFrame(Id3v2FrameIdentifiers.TDRC, value);
    } else {
      const year = parseInt(value, 10);
      if (!Number.isNaN(year) && year > 0) {
        tag.year = year;
      }
      tag.setTextFrame(Id3v2FrameIdentifiers.TYER, value.slice(0, 4));
    }
    return;
  }
  const identifier = id3TextIdentifier(lower);
  // TSST exists only in ID3v2.4. v2.3 keeps the disc subtitle as TXXX.
  if (identifier && lower === "tsst" && tag.version < 4) {
    setId3UserText(tag, "DISCSUBTITLE", value);
    return;
  }
  if (identifier) {
    if (value && isMultiValueList(lower)) {
      const values = tagValues(lower, value);
      tag.setTextFrame(identifier, ...(tag.version >= 4 ? values : [values.join("/")]));
      return;
    }
    tag.setTextFrame(identifier, value);
    return;
  }
  setId3UserText(tag, key, value);
}

function readId3Value(tag: Id3v2Tag, rawKey: string): string {
  if (rawKey.toLowerCase().startsWith("ufid:")) {
    const frames = tag.getFramesByClassType<Id3v2UniqueFileIdentifierFrame>(Id3v2FrameClassType.UniqueFileIdentifierFrame);
    return frames.find(frame => frame.owner === rawKey.slice(5))?.identifier.toString(StringType.Latin1) ?? "";
  }
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  if (lower.startsWith("txxx:")) {
    return findUserTextFrame(tag, key.slice(5))?.text?.join("; ") ?? "";
  }
  if (lower === "lyrics-eng" || lower === "lyrics" || lower === "unsyncedlyrics") {
    return tag.lyrics ?? "";
  }
  if (lower === "comment") {
    return tag.comment ?? "";
  }
  if (lower === "date" || lower === "year" || lower === "tdrc" || lower === "tyer") {
    return (
      tag.getTextAsString(Id3v2FrameIdentifiers.TDRC) ||
      tag.getTextAsString(Id3v2FrameIdentifiers.TYER) ||
      (tag.year ? String(tag.year) : "")
    );
  }
  if (lower === "original_date" || lower === "originaldate" || lower === "tdor" || lower === "tory") {
    return (
      tag.getTextAsString(Id3v2FrameIdentifiers.TDOR) ||
      tag.getTextAsString(Id3v2FrameIdentifiers.TORY) ||
      ""
    );
  }
  // TSST is ID3v2.4-only. v2.3 stores the same text as TXXX:DISCSUBTITLE.
  if ((lower === "tsst" || lower === "discsubtitle") && tag.version < 4) {
    return findUserTextFrame(tag, "DISCSUBTITLE")?.text?.join("; ") ?? "";
  }
  const identifier = id3TextIdentifier(lower);
  if (identifier) {
    return tag.getTextAsString(identifier) ?? "";
  }
  return findUserTextFrame(tag, key)?.text?.join("; ") ?? "";
}

function mp4FreeformName(rawKey: string): string | null {
  const prefix = "----:com.apple.iTunes:";
  return rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : null;
}

function setMp4Value(tag: Mpeg4AppleTag, rawKey: string, value: string): void {
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  const freeform = mp4FreeformName(key);
  if (lower === "cpil") {
    tag.setQuickTimeData(mp4BoxType(key), /^(1|true)$/i.test(value) ? [ByteVector.fromByte(1)] : [], Mpeg4AppleDataBoxFlagType.ForTempo);
    return;
  }
  if (lower === "rtng" || lower === "stik") {
    if (value && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 255)) throw new Error(`Invalid ${key} value`);
    tag.setQuickTimeData(mp4BoxType(key), value ? [ByteVector.fromByte(Number(value))] : [], Mpeg4AppleDataBoxFlagType.ForTempo);
    return;
  }
  if (lower === "isrc" || freeform?.toLowerCase() === "isrc") {
    tag.setQuickTimeString(mp4BoxType("isrc"), "");
    tag.setItunesStrings("com.apple.iTunes", "ISRC", ...parseRecordingIsrcs(value));
    return;
  }
  if (freeform !== null) {
    tag.setItunesStrings("com.apple.iTunes", freeform, ...tagValues(freeform, value));
    return;
  }
  if (lower === "track") {
    const number = parseFraction(value);
    tag.track = number.current;
    tag.trackCount = number.total;
    return;
  }
  if (lower === "disc") {
    const number = parseFraction(value);
    tag.disc = number.current;
    tag.discCount = number.total;
    return;
  }
  const box = MP4_TEXT_KEYS[lower];
  if (box) {
    if (value && isMultiValueList(box)) {
      const values = tagValues(box, value).map(item => ByteVector.fromString(item, StringType.UTF8));
      tag.setQuickTimeData(mp4BoxType(box), values, Mpeg4AppleDataBoxFlagType.ContainsText);
      return;
    }
    tag.setQuickTimeString(mp4BoxType(box), value);
    return;
  }
  if (key.length === 4) {
    tag.setQuickTimeString(mp4BoxType(key), value);
    return;
  }
  tag.setItunesStrings("com.apple.iTunes", key, ...(value ? [value] : []));
}

function readMp4Value(tag: Mpeg4AppleTag, rawKey: string): string {
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  const freeform = mp4FreeformName(key);
  if (lower === "cpil") {
    const data = tag.getFirstQuickTimeData(mp4BoxType(key), Mpeg4AppleDataBoxFlagType.ForTempo);
    return data?.length && data.get(0) ? "1" : "";
  }
  if (lower === "rtng" || lower === "stik") {
    const data = tag.getFirstQuickTimeData(mp4BoxType(key), Mpeg4AppleDataBoxFlagType.ForTempo);
    return data?.length ? String(data.get(0)) : "";
  }
  if (lower === "isrc" || freeform?.toLowerCase() === "isrc") {
    return tag.getItunesStrings("com.apple.iTunes", "ISRC").join("; ")
      || tag.getFirstQuickTimeString(mp4BoxType("isrc")) || "";
  }
  if (freeform !== null) {
    return tag.getItunesStrings("com.apple.iTunes", freeform).join("; ");
  }
  if (lower === "track") {
    return tag.trackCount > 0 ? `${tag.track}/${tag.trackCount}` : String(tag.track || "");
  }
  if (lower === "disc") {
    return tag.discCount > 0 ? `${tag.disc}/${tag.discCount}` : String(tag.disc || "");
  }
  const box = MP4_TEXT_KEYS[lower];
  if (box) {
    return readMp4TextAtom(tag, box);
  }
  if (key.length === 4) {
    return readMp4TextAtom(tag, key);
  }
  return tag.getFirstItunesString("com.apple.iTunes", key) ?? "";
}

function readMp4TextAtom(tag: Mpeg4AppleTag, box: string): string {
  if (isMultiValueList(box)) {
    return tag.getQuickTimeData(mp4BoxType(box), Mpeg4AppleDataBoxFlagType.ContainsText)
      .map(data => data.toString(StringType.UTF8)).filter(Boolean).join("; ");
  }
  // TagLib's string-list getter splits text on semicolons and trims every
  // segment. Comments and lyrics are single UTF-8 values, not artist lists.
  return tag.getFirstQuickTimeData(mp4BoxType(box), Mpeg4AppleDataBoxFlagType.ContainsText)
    ?.toString(StringType.UTF8) ?? "";
}

function writeTagLibValues(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
): void {
  const extension = extensionOf(filePath);
  withTagLibFile(filePath, (file) => {
    // TagLib creates default tags in memory. Do not introduce an ID3v1 tag
    // that was absent on disk, or scrub verification sees a new legacy tag.
    if (removeKeys.includes("ID3v1") || !(file.tagTypesOnDisk & TagTypes.Id3v1)) file.removeTags(TagTypes.Id3v1);
    if (XIPH_EXTENSIONS.has(extension)) {
      const tag = file.getTag(TagTypes.Xiph, true) as XiphComment;
      for (const key of removeKeys) tag.removeField(key);
      for (const [key, value] of Object.entries(tags)) {
        if (value) tag.setFieldAsStrings(key, ...tagValues(key, value));
      }
    } else if (ID3_EXTENSIONS.has(extension)) {
      const tag = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag;
      // New tags (AIFF/WAV start at v2.2, AAC/MP3 at v2.3) need v2.4 for
      // null-separated text and TSST. An existing v2.3 tag keeps its version.
      if (tag.version < 3 || (tag.version < 4 && tag.isEmpty)) tag.version = 4;
      for (const key of removeKeys) {
        if (key === "ID3v1") continue;
        const identifier = !key.includes(":") ? id3TextIdentifier(key) : undefined;
        if (identifier) tag.removeFrames(identifier);
        if (key.toUpperCase() === "TSST") setId3UserText(tag, "DISCSUBTITLE", "");
        if (!identifier) setId3Value(tag, key, "");
      }
      for (const [key, value] of Object.entries(tags)) {
        if (value) setId3Value(tag, key, value);
      }
    } else {
      const tag = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag;
      for (const key of removeKeys) setMp4Value(tag, key, "");
      for (const [key, value] of Object.entries(tags)) {
        if (value) setMp4Value(tag, key, value);
      }
    }
    file.save();
  });
}

function readTagLibValueFromFile(file: TagLibFile, extension: string, rawKey: string): string {
  {
    if (rawKey === "ID3v1") return (file.tagTypesOnDisk & TagTypes.Id3v1) ? "present" : "";
    if (XIPH_EXTENSIONS.has(extension)) {
      if (rawKey.toLowerCase() === "isrc") {
        return (file.getTag(TagTypes.Xiph, false) as XiphComment)?.getField(rawKey)?.join("; ") ?? "";
      }
      return (file.getTag(TagTypes.Xiph, false) as XiphComment)
        ?.getField(rawKey)?.join("; ") ?? "";
    }
    if (ID3_EXTENSIONS.has(extension)) {
      return readId3Value(file.getTag(TagTypes.Id3v2, false) as Id3v2Tag, rawKey);
    }
    return readMp4Value(file.getTag(TagTypes.Apple, false) as Mpeg4AppleTag, rawKey);
  }
}

function verifyTagLibValues(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
): void {
  // Parse the file once for every key: opening it per key re-read the whole
  // metadata block (including embedded art) 30-40 times per retagged track.
  const extension = extensionOf(filePath);
  withTagLibFile(filePath, (file) => verifyTagLibValuesInFile(file, extension, tags, removeKeys));
}

function verifyTagLibValuesInFile(
  file: TagLibFile,
  extension: string,
  tags: Record<string, string>,
  removeKeys: string[],
): void {
  for (const [key, expected] of Object.entries(tags)) {
    const actual = readTagLibValueFromFile(file, extension, key);
    if (isMultiValueList(key)) {
      if (JSON.stringify(tagValues(key, actual)) !== JSON.stringify(tagValues(key, expected))) throw new Error(`Multi-value verification failed for ${key}`);
      continue;
    }
    if (isArtistIdList(key)) {
      if (JSON.stringify(tagValues(key, actual).sort()) !== JSON.stringify(tagValues(key, expected).sort())) throw new Error(`Artist ID verification failed for ${key}`);
      continue;
    }
    if (["isrc", "tsrc", "----:com.apple.itunes:isrc"].includes(key.toLowerCase())) {
      if (parseRecordingIsrcs(actual).sort().join(";") !== parseRecordingIsrcs(expected).sort().join(";")) {
        throw new Error(`ISRC verification failed for ${key}`);
      }
      continue;
    }
    const normActual = normalizeTagValue(actual);
    const normExpected = normalizeTagValue(expected);
    if (normActual !== normExpected) {
      const isDateKey =
        key.toLowerCase().includes("date") ||
        key.toLowerCase().includes("year") ||
        key.toUpperCase() === "TDOR" ||
        key.toUpperCase() === "TDRC" ||
        key.toUpperCase() === "TORY" ||
        key.toUpperCase() === "TYER";
      if (isDateKey && normActual && normExpected && normExpected.startsWith(normActual)) {
        continue;
      }
      throw new Error(`TagLib verification failed for ${key}`);
    }
  }
  for (const key of removeKeys) {
    if (Object.hasOwn(tags, key)) continue;
    if (normalizeTagValue(readTagLibValueFromFile(file, extension, key))) {
      throw new Error(`TagLib removal verification failed for ${key}`);
    }
  }
}

const IN_PLACE_PROBE_TAIL_BYTES = 256 * 1024;

/** Byte length of the leading metadata region that TagLib rewrites for this
 * container, or null when the file layout is not eligible for an in-place
 * header rewrite (unknown container, trailing tags TagLib may also touch). */
function leadingMetadataLength(filePath: string, size: number): number | null {
  const extension = extensionOf(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const read = (position: number, length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, bytes);
    };
    if (extension === ".flac") {
      if (read(0, 4).toString("latin1") !== "fLaC") return null;
      let position = 4;
      for (let guard = 0; guard < 1024; guard++) {
        const header = read(position, 4);
        if (header.length < 4) return null;
        const last = (header[0] & 0x80) !== 0;
        position += 4 + header.readUIntBE(1, 3);
        if (position > size) return null;
        if (last) return position;
      }
      return null;
    }
    if (extension === ".mp3") {
      const header = read(0, 10);
      if (header.length < 10 || header.toString("latin1", 0, 3) !== "ID3") return null;
      const tagSize = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
      const end = 10 + tagSize + ((header[5] & 0x10) ? 10 : 0);
      // Trailing ID3v1/APE tags are rewritten at the end of the file; keep
      // those on the copy path so only the head can ever change in place.
      if (size >= 128 && read(size - 128, 3).toString("latin1") === "TAG") return null;
      if (size >= 32 && read(Math.max(0, size - 160), 160).includes("APETAGEX")) return null;
      return end <= size ? end : null;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lidarr-style in-place tag write. TagLib reuses padding, so when the new
 * metadata fits, only the leading metadata region changes. We render it on a
 * small probe (head + a slice of audio), and only if the region keeps its exact
 * length and the audio bytes are untouched do we overwrite that region of the
 * original, fsync, and verify tags and cover on the real file. The probe's
 * untouched audio tail is the structure check. The old head is fsynced to a
 * sibling undo before the original is patched and restored on any failure.
 * Returns null when the write does not fit or the layout is not eligible; the
 * caller then uses the copy+replace path.
 */
function tryWriteTagsInPlace(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
  coverPath: string | null | undefined,
): MediaTagWriteResult | null {
  const extension = extensionOf(filePath);
  if (extension !== ".flac" && extension !== ".mp3") return null;
  if (removeKeys.includes("ID3v1")) return null;
  const size = fs.statSync(filePath).size;
  const headLength = leadingMetadataLength(filePath, size);
  if (!headLength) return null;
  const probeLength = Math.min(size, headLength + IN_PLACE_PROBE_TAIL_BYTES);
  const original = Buffer.alloc(probeLength);
  {
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, original, 0, probeLength, 0); } finally { fs.closeSync(fd); }
  }
  const probePath = mediaRewritePath(filePath, "tags");
  let armed: ArmedUndo | null = null;
  try {
    fs.writeFileSync(probePath, original);
    writeTagLibValues(probePath, tags, removeKeys);
    if (coverPath) {
      withTagLibFile(probePath, (file) => {
        const picture = Picture.fromPath(coverPath);
        picture.type = PictureType.FrontCover;
        picture.description = "Cover (front)";
        file.tag.pictures = [picture];
        file.save();
      });
    }
    const rendered = fs.readFileSync(probePath);
    if (rendered.length !== probeLength) return null; // metadata grew/shrank past padding
    if (leadingMetadataLength(probePath, rendered.length) !== headLength) return null;
    if (!rendered.subarray(headLength).equals(original.subarray(headLength))) return null;
    const newHead = rendered.subarray(0, headLength);
    if (!newHead.equals(original.subarray(0, headLength))) {
      armed = armInPlaceUndo(filePath, 0, original.subarray(0, headLength), size);
      const fd = fs.openSync(filePath, "r+");
      try {
        fs.writeSync(fd, newHead, 0, headLength, 0);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      noteInPlaceWriteFinished();
    }
    const expectedCover = coverPath ? fs.readFileSync(coverPath) : null;
    withTagLibFile(filePath, (file) => {
      verifyTagLibValuesInFile(file, extension, tags, removeKeys);
      if (expectedCover) verifyCoverBytes(file, expectedCover);
    });
    if (armed) {
      markInPlaceUndoVerified(armed);
      discardInPlaceUndo(armed.id, armed.filePath);
      armed = null;
    }
    return coverPath
      ? { handled: true, success: true, backend: "taglib", coverEmbedded: true }
      : { handled: true, success: true, backend: "taglib" };
  } catch (error) {
    if (isInPlaceTagCrash(error)) throw error;
    if (armed && !restoreArmedUndo(armed, error)) {
      return { handled: true, success: false, backend: "taglib", error: errorText(error) };
    }
    console.warn(`[MediaTags] In-place tag write fell back to copy for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

function verifyCoverBytes(file: TagLibFile, expected: Buffer): void {
  const actual = file.tag.pictures[0]?.data?.toByteArray();
  if (!actual || !Buffer.from(actual).equals(expected)) throw new Error("TagLib cover verification failed");
}

function writeCoverWithTagLib(filePath: string, coverPath: string): void {
  withTagLibFile(filePath, (file) => {
    const picture = Picture.fromPath(coverPath);
    picture.type = PictureType.FrontCover;
    picture.description = "Cover (front)";
    file.tag.pictures = [picture];
    file.save();
  });
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts"]);
const MP4_SAMPLE_ENTRY_TYPES = new Set(["dec3", "ec-3", "dac3"]);
const MP4_FREE_TYPES = new Set(["free", "skip"]);

type Mp4Layout = {
  size: number;
  mdatOffset: number;
  mdatSize: number;
  mdatHeaderSize: number;
  moovOffset: number;
  moovBeforeMdat: boolean;
  ftyp: Buffer;
  sampleEntries: Buffer;
  chunkOffsets: bigint[];
};

type ParsedBox = {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  parent: number;
};

type Mp4InPlaceResult = { kind: "written" } | { kind: "fallback" } | { kind: "failed"; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containerChildStart(box: { type: string; offset: number; size: number; headerSize: number }): number | null {
  const end = box.offset + box.size;
  const start = box.type === "meta"
    ? box.offset + box.headerSize + 4
    : box.type === "stsd"
      ? box.offset + box.headerSize + 8
      : MP4_CONTAINERS.has(box.type)
        ? box.offset + box.headerSize
        : null;
  if (start === null || start > end) return null;
  return start;
}

function readHeaderFromBuffer(buffer: Buffer, offset: number, rangeEnd: number): Mp4AtomHeader | null {
  if (offset < 0 || offset + 8 > rangeEnd) return null;
  let size = buffer.readUInt32BE(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > rangeEnd) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = rangeEnd - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > rangeEnd) return null;
  return { type: buffer.toString("latin1", offset + 4, offset + 8), size, headerSize };
}

/** Header walk of one MP4. Returns null when the file has zero or several
 * `mdat` atoms, no `moov`/`ftyp`/`stco`, or a box the walker cannot trust.
 * Sample-entry bytes are the raw `dec3` / `ec-3` / `dac3` atoms under `moov`. */
function readMp4Layout(filePath: string): Mp4Layout | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const sampleChunks: Buffer[] = [];
    const chunkOffsets: bigint[] = [];
    // Assigned inside the walker. A `let` captured by that closure is not
    // narrowed afterwards, so the located atoms live on this object.
    const located: {
      mdat: { offset: number; size: number; headerSize: number } | null;
      moovOffset: number;
      ftyp: Buffer | null;
    } = { mdat: null, moovOffset: -1, ftyp: null };
    const readBytes = (offset: number, length: number): Buffer | null => {
      if (length < 0 || offset < 0 || offset + length > size) return null;
      const buffer = Buffer.alloc(length);
      return fs.readSync(fd!, buffer, 0, length, offset) === length ? buffer : null;
    };
    const walk = (start: number, end: number, depth: number): boolean => {
      if (depth > 16) return false;
      let position = start;
      while (position + 8 <= end) {
        const atom = readMp4AtomHeader(fd!, position, end);
        if (!atom) return false;
        if (atom.type === "mdat") {
          if (located.mdat) return false;
          located.mdat = { offset: position, size: atom.size, headerSize: atom.headerSize };
        } else if (atom.type === "moov") {
          if (located.moovOffset >= 0) return false;
          located.moovOffset = position;
        } else if (atom.type === "ftyp" && !located.ftyp) {
          located.ftyp = readBytes(position, atom.size);
          if (!located.ftyp) return false;
        }
        if (MP4_SAMPLE_ENTRY_TYPES.has(atom.type)) {
          const bytes = readBytes(position, atom.size);
          if (!bytes) return false;
          sampleChunks.push(bytes);
        } else if (atom.type === "stco" || atom.type === "co64") {
          const body = readBytes(position + atom.headerSize, atom.size - atom.headerSize);
          if (!body || body.length < 8) return false;
          const count = body.readUInt32BE(4);
          const wide = atom.type === "co64";
          const width = wide ? 8 : 4;
          if (8 + count * width > body.length) return false;
          for (let index = 0; index < count; index += 1) {
            const at = 8 + index * width;
            chunkOffsets.push(wide ? body.readBigUInt64BE(at) : BigInt(body.readUInt32BE(at)));
          }
        } else {
          const childStart = containerChildStart({
            type: atom.type, offset: position, size: atom.size, headerSize: atom.headerSize,
          });
          if (childStart !== null && !walk(childStart, position + atom.size, depth + 1)) return false;
        }
        position += atom.size;
      }
      return true;
    };
    if (!walk(0, size, 0)) return null;
    const mdat = located.mdat;
    const ftyp = located.ftyp;
    const moovOffset = located.moovOffset;
    if (!mdat || moovOffset < 0 || !ftyp || chunkOffsets.length === 0) return null;
    return {
      size,
      mdatOffset: mdat.offset,
      mdatSize: mdat.size,
      mdatHeaderSize: mdat.headerSize,
      moovOffset,
      moovBeforeMdat: moovOffset < mdat.offset,
      ftyp,
      sampleEntries: sampleChunks.length > 0 ? Buffer.concat(sampleChunks) : Buffer.alloc(0),
      chunkOffsets,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function parseBoxTree(buffer: Buffer): ParsedBox[] | null {
  const boxes: ParsedBox[] = [];
  const walk = (start: number, end: number, parent: number, depth: number): boolean => {
    if (depth > 16) return false;
    let position = start;
    while (position + 8 <= end) {
      const header = readHeaderFromBuffer(buffer, position, end);
      if (!header) return false;
      const index = boxes.length;
      const box: ParsedBox = {
        type: header.type, offset: position, size: header.size, headerSize: header.headerSize, parent,
      };
      boxes.push(box);
      const childStart = containerChildStart(box);
      if (childStart !== null && !walk(childStart, position + header.size, index, depth + 1)) return false;
      position += header.size;
    }
    return true;
  };
  return walk(0, buffer.length, -1, 0) ? boxes : null;
}

function writeParsedBoxSize(buffer: Buffer, offset: number, size: number, headerSize: number): boolean {
  if (!Number.isSafeInteger(size) || size < headerSize) return false;
  if (buffer.readUInt32BE(offset) === 1) {
    buffer.writeBigUInt64BE(BigInt(size), offset + 8);
    return true;
  }
  if (size > 0xffffffff) return false;
  buffer.writeUInt32BE(size, offset);
  return true;
}

function spliceOut(buffer: Buffer, offset: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(buffer.length - length);
  buffer.copy(out, 0, 0, offset);
  buffer.copy(out, offset, offset + length);
  return out;
}

/** TagLib's MPEG-4 save appends a new `free` atom inside `meta` and, when the
 * file grows, adds that growth to every chunk offset at or after `udta`.
 * Shrink `free`/`skip` atoms that start at or after `stco` until the header is
 * back to `targetLength`, then subtract the growth so `mdat` stays put. Returns
 * null when the padding cannot absorb the growth; the caller copies the file. */
function fitMp4Prefix(rendered: Buffer, targetLength: number, mdatOffset: number): Buffer | null {
  if (rendered.length < targetLength) return null;
  const growth = rendered.length - targetLength;
  let buffer = rendered;
  let need = growth;
  while (need > 0) {
    const boxes = parseBoxTree(buffer);
    if (!boxes) return null;
    let stcoAt = -1;
    for (const box of boxes) {
      if ((box.type === "stco" || box.type === "co64") && (stcoAt < 0 || box.offset < stcoAt)) stcoAt = box.offset;
    }
    if (stcoAt < 0) return null;
    const candidates = boxes
      .filter((box) => MP4_FREE_TYPES.has(box.type) && box.offset >= stcoAt && box.size > box.headerSize)
      .sort((left, right) => right.offset - left.offset);
    if (candidates.length === 0) return null;
    const box = candidates[0];
    const cut = Math.min(need, box.size - box.headerSize);
    if (!writeParsedBoxSize(buffer, box.offset, box.size - cut, box.headerSize)) return null;
    let parent = box.parent;
    while (parent >= 0) {
      const ancestor = boxes[parent];
      if (!writeParsedBoxSize(buffer, ancestor.offset, ancestor.size - cut, ancestor.headerSize)) return null;
      parent = ancestor.parent;
    }
    buffer = spliceOut(buffer, box.offset + box.size - cut, cut);
    need -= cut;
  }
  if (buffer.length !== targetLength) return null;
  if (growth !== 0 && !adjustChunkOffsets(buffer, -growth, BigInt(mdatOffset))) return null;
  return parseBoxTree(buffer) ? buffer : null;
}

function adjustChunkOffsets(buffer: Buffer, delta: number, threshold: bigint): boolean {
  const boxes = parseBoxTree(buffer);
  if (!boxes) return false;
  for (const box of boxes) {
    if (box.type !== "stco" && box.type !== "co64") continue;
    const wide = box.type === "co64";
    const body = box.offset + box.headerSize;
    if (body + 8 > buffer.length) return false;
    const count = buffer.readUInt32BE(body + 4);
    const width = wide ? 8 : 4;
    if (body + 8 + count * width > box.offset + box.size) return false;
    for (let index = 0; index < count; index += 1) {
      const at = body + 8 + index * width;
      if (wide) {
        const value = buffer.readBigUInt64BE(at);
        if (value < threshold) continue;
        const next = value + BigInt(delta);
        if (next < 0n) return false;
        buffer.writeBigUInt64BE(next, at);
      } else {
        const value = buffer.readUInt32BE(at);
        if (BigInt(value) < threshold) continue;
        const next = value + delta;
        if (next < 0 || next > 0xffffffff) return false;
        buffer.writeUInt32BE(next, at);
      }
    }
  }
  return true;
}

function sameChunkOffsets(left: bigint[], right: bigint[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function assertMp4AudioPreserved(before: Mp4Layout, after: Mp4Layout | null, samePlace: boolean): void {
  if (!after) throw new Error("MP4 layout became unreadable");
  if (!before.ftyp.equals(after.ftyp)) throw new Error("MP4 ftyp changed");
  const beforePayload = before.mdatSize - before.mdatHeaderSize;
  const afterPayload = after.mdatSize - after.mdatHeaderSize;
  if (beforePayload !== afterPayload) throw new Error("MP4 mdat payload length changed");
  if (!before.sampleEntries.equals(after.sampleEntries)) throw new Error("MP4 audio sample entry changed");
  if (!samePlace) return;
  if (before.mdatOffset !== after.mdatOffset || before.mdatSize !== after.mdatSize) throw new Error("MP4 mdat moved");
  if (!sameChunkOffsets(before.chunkOffsets, after.chunkOffsets)) throw new Error("MP4 chunk offsets changed");
}

/** Put the original region back and drop the undo. False leaves the undo armed
 * so startup recovery can still repair the file; the caller must not copy. */
function restoreArmedUndo(armed: ArmedUndo, error: unknown): boolean {
  try {
    restoreInPlaceUndo(armed);
    discardInPlaceUndo(armed.id, armed.filePath);
    return true;
  } catch (restoreError) {
    console.warn(`[MediaTags] In-place restore failed for ${armed.filePath}: ${errorText(error)}; ${errorText(restoreError)}`);
    return false;
  }
}

/** In-place MP4 tag mutation. `mdat` before `moov` is saved on the original and
 * the `moov` tail is restored on failure. `moov` before `mdat` is rendered on a
 * header probe and patched back only when padding can keep `mdat` at its
 * offset. A layout that cannot be patched returns `fallback` with the original
 * bytes untouched so the caller can copy the file. */
function tryMutateMp4InPlace(
  filePath: string,
  mutate: (targetPath: string) => void,
  verify: (targetPath: string) => void,
): Mp4InPlaceResult {
  const before = readMp4Layout(filePath);
  if (!before) return { kind: "fallback" };
  return before.moovBeforeMdat
    ? mutateMp4Prefix(filePath, before, mutate, verify)
    : mutateMp4Tail(filePath, before, mutate, verify);
}

function mutateMp4Prefix(
  filePath: string,
  before: Mp4Layout,
  mutate: (targetPath: string) => void,
  verify: (targetPath: string) => void,
): Mp4InPlaceResult {
  const probePath = mediaRewritePath(filePath, "tags");
  const prefix = Buffer.alloc(before.mdatOffset);
  const readFd = fs.openSync(filePath, "r");
  try {
    if (fs.readSync(readFd, prefix, 0, prefix.length, 0) !== prefix.length) return { kind: "fallback" };
  } finally {
    fs.closeSync(readFd);
  }
  let armed: ArmedUndo | null = null;
  try {
    fs.writeFileSync(probePath, prefix);
    try {
      mutate(probePath);
    } catch {
      return { kind: "fallback" };
    }
    const rendered = fs.readFileSync(probePath);
    const fitted = rendered.length === before.mdatOffset
      ? rendered
      : fitMp4Prefix(rendered, before.mdatOffset, before.mdatOffset);
    if (!fitted || fitted.length !== before.mdatOffset) return { kind: "fallback" };
    if (!fitted.equals(prefix)) {
      armed = armInPlaceUndo(filePath, 0, prefix, before.size);
      const out = fs.openSync(filePath, "r+");
      try {
        fs.writeSync(out, fitted, 0, fitted.length, 0);
        fs.fsyncSync(out);
      } finally {
        fs.closeSync(out);
      }
      noteInPlaceWriteFinished();
    }
    verify(filePath);
    assertMp4AudioPreserved(before, readMp4Layout(filePath), true);
    if (armed) {
      markInPlaceUndoVerified(armed);
      discardInPlaceUndo(armed.id, armed.filePath);
      armed = null;
    }
    return { kind: "written" };
  } catch (error) {
    if (isInPlaceTagCrash(error)) throw error;
    if (armed && !restoreArmedUndo(armed, error)) {
      return { kind: "failed", error: errorText(error) };
    }
    return { kind: "fallback" };
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

function mutateMp4Tail(
  filePath: string,
  before: Mp4Layout,
  mutate: (targetPath: string) => void,
  verify: (targetPath: string) => void,
): Mp4InPlaceResult {
  const tailLength = before.size - before.moovOffset;
  if (tailLength <= 0) return { kind: "fallback" };
  const tail = Buffer.alloc(tailLength);
  const readFd = fs.openSync(filePath, "r");
  try {
    if (fs.readSync(readFd, tail, 0, tail.length, before.moovOffset) !== tail.length) return { kind: "fallback" };
  } finally {
    fs.closeSync(readFd);
  }
  let armed: ArmedUndo | null = null;
  try {
    armed = armInPlaceUndo(filePath, before.moovOffset, tail, before.size);
    mutate(filePath);
    fsyncMediaFile(filePath);
    noteInPlaceWriteFinished();
    verify(filePath);
    assertMp4AudioPreserved(before, readMp4Layout(filePath), true);
    markInPlaceUndoVerified(armed);
    discardInPlaceUndo(armed.id, armed.filePath);
    armed = null;
    return { kind: "written" };
  } catch (error) {
    if (isInPlaceTagCrash(error)) throw error;
    if (armed && !restoreArmedUndo(armed, error)) {
      return { kind: "failed", error: errorText(error) };
    }
    return { kind: "fallback" };
  }
}

function writtenResult(coverPath?: string | null): MediaTagWriteResult {
  return coverPath
    ? { handled: true, success: true, backend: "taglib", coverEmbedded: true }
    : { handled: true, success: true, backend: "taglib" };
}

function copyTagLibWorkingFile(
  filePath: string,
  mutate: (workingPath: string) => void,
  verify: (workingPath: string) => void,
  coverPath?: string | null,
): MediaTagWriteResult {
  const extension = extensionOf(filePath);
  const beforeLayout = MP4_EXTENSIONS.has(extension) ? readMp4Layout(filePath) : null;
  const workingPath = mediaRewritePath(filePath, "tags");
  try {
    fs.copyFileSync(filePath, workingPath);
    mutate(workingPath);
    verify(workingPath);
    if (beforeLayout) assertMp4AudioPreserved(beforeLayout, readMp4Layout(workingPath), false);
    replaceMediaFile(filePath, workingPath);
    return writtenResult(coverPath);
  } catch (error) {
    fs.rmSync(workingPath, { force: true });
    return { handled: true, success: false, backend: "taglib", error: errorText(error) };
  }
}

export async function writeMediaTagsWithTagLib(
  filePath: string, tags: Record<string, string>, removeKeys: string[] = [], coverPath?: string | null,
): Promise<MediaTagWriteResult> {
  return withMediaFileLock(filePath, () => writeMediaTagsWithTagLibUnlocked(filePath, tags, removeKeys, coverPath));
}

function verifyWrittenTags(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
  coverPath?: string | null,
): void {
  const expectedCover = coverPath ? fs.readFileSync(coverPath) : null;
  withTagLibFile(filePath, (file) => {
    verifyTagLibValuesInFile(file, extensionOf(filePath), tags, removeKeys);
    if (expectedCover) verifyCoverBytes(file, expectedCover);
  });
}

async function writeMediaTagsWithTagLibUnlocked(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[] = [],
  coverPath?: string | null,
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }

  const extension = extensionOf(filePath);
  if (extension === ".flac" || extension === ".mp3") {
    const inPlace = tryWriteTagsInPlace(filePath, tags, removeKeys, coverPath);
    if (inPlace) return inPlace;
  } else if (MP4_EXTENSIONS.has(extension)) {
    const attempt = tryMutateMp4InPlace(
      filePath,
      (target) => {
        writeTagLibValues(target, tags, removeKeys);
        if (coverPath) writeCoverWithTagLib(target, coverPath);
      },
      (target) => verifyWrittenTags(target, tags, removeKeys, coverPath),
    );
    if (attempt.kind === "written") return writtenResult(coverPath);
    if (attempt.kind === "failed") {
      return { handled: true, success: false, backend: "taglib", error: attempt.error };
    }
  }

  return copyTagLibWorkingFile(
    filePath,
    (workingPath) => {
      writeTagLibValues(workingPath, tags, removeKeys);
      if (coverPath) writeCoverWithTagLib(workingPath, coverPath);
    },
    (workingPath) => verifyWrittenTags(workingPath, tags, removeKeys, coverPath),
    coverPath,
  );
}

export async function clearMediaTagsWithTagLib(
  filePath: string,
): Promise<MediaTagWriteResult> {
  return withMediaFileLock(filePath, () => clearMediaTagsWithTagLibUnlocked(filePath));
}

function clearTagsOn(filePath: string): void {
  withTagLibFile(filePath, (file) => {
    const pictures = file.tag.pictures.map((picture) => {
      const copy = Picture.fromFullData(
        picture.data,
        picture.type,
        picture.mimeType,
        picture.description,
      );
      copy.filename = picture.filename;
      return copy;
    });
    file.tag.clear();
    file.tag.pictures = pictures;
    file.save();
  });
}

function verifyClearedTags(filePath: string): void {
  withTagLibFile(filePath, (file) => {
    if (
      file.tag.title
      || file.tag.album
      || file.tag.performers.length > 0
      || file.tag.comment
      || file.tag.lyrics
    ) {
      throw new Error("TagLib clear verification failed");
    }
  });
}

async function clearMediaTagsWithTagLibUnlocked(
  filePath: string,
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }
  if (MP4_EXTENSIONS.has(extensionOf(filePath))) {
    const attempt = tryMutateMp4InPlace(filePath, clearTagsOn, verifyClearedTags);
    if (attempt.kind === "written") return { handled: true, success: true, backend: "taglib" };
    if (attempt.kind === "failed") {
      return { handled: true, success: false, backend: "taglib", error: attempt.error };
    }
  }
  return copyTagLibWorkingFile(filePath, clearTagsOn, verifyClearedTags);
}

export function readMediaCoverWithTagLib(filePath: string): Buffer | null {
  if (!canHandleWithTagLib(filePath)) return null;
  try {
    return withTagLibFile(filePath, file => {
      const pictures = file.tag.pictures;
      const picture = pictures.find(item => item.type === PictureType.FrontCover) ?? pictures[0];
      const bytes = picture?.data?.toByteArray();
      return bytes?.length ? Buffer.from(bytes) : null;
    });
  } catch {
    return null;
  }
}

export async function replaceMediaCoverWithTagLib(
  filePath: string, coverPath: string,
): Promise<MediaTagWriteResult> {
  return withMediaFileLock(filePath, () => replaceMediaCoverWithTagLibUnlocked(filePath, coverPath));
}

function verifyReplacedCover(filePath: string, coverPath: string): void {
  const expected = fs.readFileSync(coverPath);
  withTagLibFile(filePath, (file) => verifyCoverBytes(file, expected));
}

async function replaceMediaCoverWithTagLibUnlocked(
  filePath: string,
  coverPath: string,
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }
  if (MP4_EXTENSIONS.has(extensionOf(filePath))) {
    const attempt = tryMutateMp4InPlace(
      filePath,
      (target) => writeCoverWithTagLib(target, coverPath),
      (target) => verifyReplacedCover(target, coverPath),
    );
    if (attempt.kind === "written") return { handled: true, success: true, backend: "taglib" };
    if (attempt.kind === "failed") {
      return { handled: true, success: false, backend: "taglib", error: attempt.error };
    }
  }
  return copyTagLibWorkingFile(
    filePath,
    (workingPath) => writeCoverWithTagLib(workingPath, coverPath),
    (workingPath) => verifyReplacedCover(workingPath, coverPath),
  );
}
