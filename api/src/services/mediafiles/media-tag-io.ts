import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ByteVector,
  File as TagLibFile,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2Tag,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleTag,
  Picture,
  PictureType,
  ReadStyle,
  StringType,
  TagTypes,
  XiphComment,
} from "node-taglib-sharp";

const TAGLIB_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".opus",
]);

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
  genre: "TCON",
  isrc: "TSRC",
  copyright: "TCOP",
  publisher: "TPUB",
  tmed: "TMED",
  tkey: "TKEY",
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
  composer: "\xa9wrt",
  lyrics: "\xa9lyr",
  "lyrics-eng": "\xa9lyr",
  isrc: "isrc",
};

export type MediaTagWriteResult = {
  handled: boolean;
  success: boolean;
  backend?: "taglib";
  error?: string;
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

type MediaStructureSnapshot = {
  durationMilliseconds: number;
  mediaTypes: number;
  codecDescriptions: string[];
  audioChannels: number;
  audioSampleRate: number;
  bitsPerSample: number;
  videoWidth: number;
  videoHeight: number;
};

function readMediaStructure(filePath: string): MediaStructureSnapshot {
  return withTagLibFile(filePath, (file) => ({
    durationMilliseconds: file.properties.durationMilliseconds,
    mediaTypes: file.properties.mediaTypes,
    codecDescriptions: file.properties.codecs.map((codec) => codec?.description ?? ""),
    audioChannels: file.properties.audioChannels,
    audioSampleRate: file.properties.audioSampleRate,
    bitsPerSample: file.properties.bitsPerSample,
    videoWidth: file.properties.videoWidth,
    videoHeight: file.properties.videoHeight,
  }), ReadStyle.Average);
}

function verifyMediaStructure(
  filePath: string,
  expected: MediaStructureSnapshot,
): void {
  const actual = readMediaStructure(filePath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `TagLib media-structure verification failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
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
  frame.text = [value];
  if (!existing) tag.addFrame(frame);
}

function id3TextIdentifier(key: string) {
  const identifier = ID3_TEXT_KEYS[key.toLowerCase()];
  return identifier ? Id3v2FrameIdentifiers[identifier] : undefined;
}

function setId3Value(tag: Id3v2Tag, rawKey: string, value: string): void {
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
  const identifier = id3TextIdentifier(lower);
  if (identifier) {
    tag.setTextFrame(identifier, value);
    return;
  }
  setId3UserText(tag, key, value);
}

function readId3Value(tag: Id3v2Tag, rawKey: string): string {
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  if (lower.startsWith("txxx:")) {
    return findUserTextFrame(tag, key.slice(5))?.text?.[0] ?? "";
  }
  if (lower === "lyrics-eng" || lower === "lyrics" || lower === "unsyncedlyrics") {
    return tag.lyrics ?? "";
  }
  if (lower === "comment") {
    return tag.comment ?? "";
  }
  const identifier = id3TextIdentifier(lower);
  if (identifier) {
    return tag.getTextAsString(identifier) ?? "";
  }
  return findUserTextFrame(tag, key)?.text?.[0] ?? "";
}

function mp4FreeformName(rawKey: string): string | null {
  const prefix = "----:com.apple.iTunes:";
  return rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : null;
}

function setMp4Value(tag: Mpeg4AppleTag, rawKey: string, value: string): void {
  const key = rawKey.trim();
  const lower = key.toLowerCase();
  const freeform = mp4FreeformName(key);
  if (freeform !== null) {
    tag.setItunesStrings("com.apple.iTunes", freeform, ...(value ? [value] : []));
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
  if (freeform !== null) {
    return tag.getFirstItunesString("com.apple.iTunes", freeform) ?? "";
  }
  if (lower === "track") {
    return tag.trackCount > 0 ? `${tag.track}/${tag.trackCount}` : String(tag.track || "");
  }
  if (lower === "disc") {
    return tag.discCount > 0 ? `${tag.disc}/${tag.discCount}` : String(tag.disc || "");
  }
  const box = MP4_TEXT_KEYS[lower];
  if (box) {
    return tag.getFirstQuickTimeString(mp4BoxType(box)) ?? "";
  }
  if (key.length === 4) {
    return tag.getFirstQuickTimeString(mp4BoxType(key)) ?? "";
  }
  return tag.getFirstItunesString("com.apple.iTunes", key) ?? "";
}

function writeTagLibValues(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
): void {
  const extension = extensionOf(filePath);
  withTagLibFile(filePath, (file) => {
    if (XIPH_EXTENSIONS.has(extension)) {
      const tag = file.getTag(TagTypes.Xiph, true) as XiphComment;
      for (const key of removeKeys) tag.removeField(key);
      for (const [key, value] of Object.entries(tags)) {
        if (value) tag.setFieldAsStrings(key, value);
      }
    } else if (extension === ".mp3" || extension === ".aac") {
      const tag = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag;
      for (const key of removeKeys) setId3Value(tag, key, "");
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

function readTagLibValue(filePath: string, rawKey: string): string {
  const extension = extensionOf(filePath);
  return withTagLibFile(filePath, (file) => {
    if (XIPH_EXTENSIONS.has(extension)) {
      return (file.getTag(TagTypes.Xiph, false) as XiphComment)
        ?.getFieldFirstValue(rawKey) ?? "";
    }
    if (extension === ".mp3" || extension === ".aac") {
      return readId3Value(file.getTag(TagTypes.Id3v2, false) as Id3v2Tag, rawKey);
    }
    return readMp4Value(file.getTag(TagTypes.Apple, false) as Mpeg4AppleTag, rawKey);
  });
}

function verifyTagLibValues(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[],
): void {
  for (const [key, expected] of Object.entries(tags)) {
    const actual = readTagLibValue(filePath, key);
    if (normalizeTagValue(actual) !== normalizeTagValue(expected)) {
      throw new Error(`TagLib verification failed for ${key}`);
    }
  }
  for (const key of removeKeys) {
    if (Object.hasOwn(tags, key)) continue;
    if (normalizeTagValue(readTagLibValue(filePath, key))) {
      throw new Error(`TagLib removal verification failed for ${key}`);
    }
  }
}

function replaceOriginalWithVerifiedCopy(originalPath: string, workingPath: string): void {
  const backupPath = path.join(
    path.dirname(originalPath),
    `.discogenius-tags-backup-${randomUUID()}${extensionOf(originalPath)}`,
  );
  fs.renameSync(originalPath, backupPath);
  try {
    fs.renameSync(workingPath, originalPath);
  } catch (error) {
    fs.renameSync(backupPath, originalPath);
    throw error;
  }
  fs.rmSync(backupPath, { force: true });
}

function workingCopyPath(filePath: string): string {
  const extension = extensionOf(filePath);
  return path.join(
    path.dirname(filePath),
    `.discogenius-tags-${randomUUID()}${extension}`,
  );
}

export async function writeMediaTagsWithTagLib(
  filePath: string,
  tags: Record<string, string>,
  removeKeys: string[] = [],
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }

  const workingPath = workingCopyPath(filePath);
  try {
    const mediaStructure = readMediaStructure(filePath);
    fs.copyFileSync(filePath, workingPath);
    writeTagLibValues(workingPath, tags, removeKeys);
    verifyTagLibValues(workingPath, tags, removeKeys);
    verifyMediaStructure(workingPath, mediaStructure);
    replaceOriginalWithVerifiedCopy(filePath, workingPath);
    return { handled: true, success: true, backend: "taglib" };
  } catch (error) {
    fs.rmSync(workingPath, { force: true });
    return {
      handled: true,
      success: false,
      backend: "taglib",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function clearMediaTagsWithTagLib(
  filePath: string,
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }

  const workingPath = workingCopyPath(filePath);
  try {
    const mediaStructure = readMediaStructure(filePath);
    fs.copyFileSync(filePath, workingPath);
    withTagLibFile(workingPath, (file) => {
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
    withTagLibFile(workingPath, (file) => {
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
    verifyMediaStructure(workingPath, mediaStructure);
    replaceOriginalWithVerifiedCopy(filePath, workingPath);
    return { handled: true, success: true, backend: "taglib" };
  } catch (error) {
    fs.rmSync(workingPath, { force: true });
    return {
      handled: true,
      success: false,
      backend: "taglib",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function replaceMediaCoverWithTagLib(
  filePath: string,
  coverPath: string,
): Promise<MediaTagWriteResult> {
  if (!canHandleWithTagLib(filePath)) {
    return { handled: false, success: false };
  }

  const workingPath = workingCopyPath(filePath);
  try {
    const expected = fs.readFileSync(coverPath);
    const mediaStructure = readMediaStructure(filePath);
    fs.copyFileSync(filePath, workingPath);
    withTagLibFile(workingPath, (file) => {
      const picture = Picture.fromPath(coverPath);
      picture.type = PictureType.FrontCover;
      picture.description = "Cover (front)";
      file.tag.pictures = [picture];
      file.save();
    });
    withTagLibFile(workingPath, (file) => {
      const actual = file.tag.pictures[0]?.data?.toByteArray();
      if (!actual || !Buffer.from(actual).equals(expected)) {
        throw new Error("TagLib cover verification failed");
      }
    });
    verifyMediaStructure(workingPath, mediaStructure);
    replaceOriginalWithVerifiedCopy(filePath, workingPath);
    return { handled: true, success: true, backend: "taglib" };
  } catch (error) {
    fs.rmSync(workingPath, { force: true });
    return {
      handled: true,
      success: false,
      backend: "taglib",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
