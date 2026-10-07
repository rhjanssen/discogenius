import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as jpeg from "jpeg-js";
import * as pngjs from "pngjs";
import { db, withSqliteWriteGate } from "../../database.js";
import { storeArtworkSource } from "./media-cover-state.js";
import { rememberLibraryCoverSidecar } from "./media-cover-library-storage.js";
import { decodeImage, extensionForImage, fetchArtworkWithFallbacks, readArtworkBuffer } from "./media-cover-image.js";
import { getCachedMediaCoverOriginalFilePath, syncCachedMediaCoverToFile, normalizeMediaCoverEntityId,
  getSelectedArtworkSource, getMediaCoverFolder, normalizeMediaCoverType, mediaCoverFileSha256,
  normalizeArtworkUrl, configuredArtworkPreference, type MediaCoverSidecarOptions, type MediaCoverSidecarSyncResult } from "./media-cover-service.js";
const PNG = (pngjs as unknown as { PNG: any }).PNG as any;

/** Import/metadata-refresh only. Fetch the already selected source when no
 * local master exists; never select a provider or promote a display proxy.
 * Retag and pure disk inventory remain local-only. Missing-sidecar repair may
 * fetch this selected asset as part of its separate metadata work. */
export async function materializeMediaCoverToFile(options: MediaCoverSidecarOptions): Promise<MediaCoverSidecarSyncResult> {
  const entityId = normalizeMediaCoverEntityId(options.entityId);
  if (!entityId) return "missing";
  const types = Array.isArray(options.coverTypes) ? options.coverTypes
    : [options.coverTypes || (options.coverEntity === "Artist" ? "poster" : "cover")];
  for (const coverType of types) {
    if (!getCachedMediaCoverOriginalFilePath(entityId, options.coverEntity, coverType)) continue;
    const marker = getSelectedArtworkSource(entityId, options.coverEntity, coverType);
    if (marker && marker.preference !== configuredArtworkPreference()) throw new Error("Artwork preference changed; resolve artwork before materializing it");
    return syncCachedMediaCoverToFile({ ...options, coverTypes: coverType });
  }
  const selected = types.map(normalizeMediaCoverType).map(coverType => ({
    identity: { entityId, coverEntity: options.coverEntity, coverType },
    source: getSelectedArtworkSource(entityId, options.coverEntity, coverType),
  })).find(candidate => candidate.source && normalizeArtworkUrl(candidate.source.url));
  if (!selected?.source) return "missing";
  const { identity, source } = selected;
  if (source.preference !== configuredArtworkPreference()) throw new Error("Artwork preference changed; resolve artwork before materializing it");
  const fetched = await fetchArtworkWithFallbacks(source.url);
  if (!fetched) throw new Error(`Could not fetch selected ${options.coverEntity} artwork`);
  const extension = extensionForImage(fetched.response.headers.get("content-type"), fetched.fetchedUrl);
  const origin = await readArtworkBuffer(fetched.response);
  const decoded = decodeImage(origin, extension);
  if (!decoded) throw new Error(`Selected artwork container ${extension} cannot yet be materialized safely`);
  const destinationExtension = path.extname(options.outputPath).toLowerCase();
  let master: Buffer;
  if (destinationExtension === ".jpg" || destinationExtension === ".jpeg") {
    master = extension === ".jpg" || extension === ".jpeg" ? origin
      : Buffer.from(jpeg.encode(decoded, 95).data);
  } else if (destinationExtension === extension) {
    master = origin;
  } else if (destinationExtension === ".png") {
    master = PNG.sync.write({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });
  } else {
    throw new Error(`Unsupported library artwork extension ${destinationExtension}`);
  }
  const hash = crypto.createHash("sha256").update(master).digest("hex");
  const witness = () => {
    try {
      const stat = fs.lstatSync(options.outputPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artwork destination is not a regular file");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const destinationWitness = witness();
  const unchanged = fs.existsSync(options.outputPath) && mediaCoverFileSha256(options.outputPath) === hash;
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const staged = `${options.outputPath}.${crypto.randomUUID()}.tmp`;
  const backup = `${options.outputPath}.${crypto.randomUUID()}.previous`;
  let replaced = false;
  let keepBackup = false;
  try {
    if (!unchanged) fs.writeFileSync(staged, master);
    await withSqliteWriteGate(() => {
      const current = getSelectedArtworkSource(entityId, options.coverEntity, identity.coverType);
      if (JSON.stringify(current) !== JSON.stringify(source) || configuredArtworkPreference() !== source.preference) {
        throw new Error("Artwork source changed during materialization; retry with the selected source");
      }
      if (witness() !== destinationWitness) throw new Error("Artwork destination changed during materialization; retry after inventory");
      try {
        db.transaction(() => {
          if (!unchanged) {
            if (fs.existsSync(options.outputPath)) fs.linkSync(options.outputPath, backup);
            fs.renameSync(staged, options.outputPath);
            replaced = true;
          }
          const row = db.prepare("SELECT id FROM MetadataFiles WHERE file_path = ? AND file_type IN ('cover','artwork','video_thumbnail','video_cover')")
            .get(options.outputPath) as { id: number } | undefined;
          rememberLibraryCoverSidecar(identity, getMediaCoverFolder(entityId, options.coverEntity), options.outputPath, hash, row?.id);
          storeArtworkSource(identity, { ...source, contentHash: hash });
        })();
      } catch (error) {
        if (replaced) {
          try {
            if (fs.existsSync(backup)) fs.renameSync(backup, options.outputPath);
            else fs.unlinkSync(options.outputPath);
          } catch (restoreError) {
            keepBackup = true;
            throw new AggregateError([error, restoreError], `Artwork replacement failed; recovery copy retained at ${backup}`);
          }
        }
        throw error;
      }
    }, "materialize selected library artwork");
  } finally {
    fs.rmSync(staged, { force: true });
    if (!keepBackup) fs.rmSync(backup, { force: true });
  }
  return unchanged ? "unchanged" : "written";
}

