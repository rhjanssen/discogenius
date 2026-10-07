import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as jpeg from "jpeg-js";
import * as pngjs from "pngjs";
import { db, withSqliteWriteGate } from "../../database.js";
import { storeArtworkSource } from "./media-cover-state.js";
import { rememberLibraryCoverSidecar } from "./media-cover-library-storage.js";
import { decodeArtworkImage, extensionForImage, fetchArtworkWithFallbacks, readArtworkBuffer } from "./media-cover-image.js";
import { ArtworkMutationJournal } from "./artwork-mutation-journal.js";
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
  const preference = configuredArtworkPreference();
  const candidates = types.map(normalizeMediaCoverType).map(coverType => ({
    identity: { entityId, coverEntity: options.coverEntity, coverType },
    source: getSelectedArtworkSource(entityId, options.coverEntity, coverType),
    localPath: getCachedMediaCoverOriginalFilePath(entityId, options.coverEntity, coverType),
  }));
  const selected = candidates.find(candidate => candidate.localPath)
    ?? candidates.find(candidate => candidate.source && normalizeArtworkUrl(candidate.source.url));
  if (!selected) return "missing";
  const { identity, source, localPath } = selected;
  if (source && source.preference !== preference) throw new Error("Artwork preference changed; resolve artwork before materializing it");
  const normalizedExtension = (file: string) => path.extname(file).toLowerCase().replace(/^\.jpeg$/, ".jpg");
  if (localPath && normalizedExtension(localPath) === normalizedExtension(options.outputPath)) {
    return syncCachedMediaCoverToFile({ ...options, coverTypes: identity.coverType });
  }
  const fileWitness = (file: string) => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artwork path is not a regular file");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const localWitness = localPath ? fileWitness(localPath) : null;
  let extension: string, origin: Buffer;
  if (localPath) {
    if (fs.statSync(localPath).size > 32 * 1024 * 1024) throw new Error("Artwork exceeds the 32 MiB conversion limit");
    origin = fs.readFileSync(localPath);
    extension = normalizedExtension(localPath);
  } else {
    const fetched = await fetchArtworkWithFallbacks(source!.url);
    if (!fetched) throw new Error(`Could not fetch selected ${options.coverEntity} artwork`);
    extension = extensionForImage(fetched.response.headers.get("content-type"), fetched.fetchedUrl);
    origin = await readArtworkBuffer(fetched.response);
  }
  const decoded = await decodeArtworkImage(origin, extension);
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
  const witness = () => fileWitness(options.outputPath);
  const destinationWitness = witness();
  const unchanged = fs.existsSync(options.outputPath) && mediaCoverFileSha256(options.outputPath) === hash;
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const staged = `${options.outputPath}.${crypto.randomUUID()}.tmp`;
  let intentId: string | null = null;
  try {
    if (!unchanged) fs.writeFileSync(staged, master);
    await withSqliteWriteGate(() => {
      const current = getSelectedArtworkSource(entityId, options.coverEntity, identity.coverType);
      if (JSON.stringify(current) !== JSON.stringify(source) || configuredArtworkPreference() !== preference) {
        throw new Error("Artwork source changed during materialization; retry with the selected source");
      }
      if (localPath && fileWitness(localPath) !== localWitness) throw new Error("Artwork master changed during conversion; retry after inventory");
      if (witness() !== destinationWitness) throw new Error("Artwork destination changed during materialization; retry after inventory");
      try {
        if (!unchanged) {
          intentId = ArtworkMutationJournal.prepare(identity,options.outputPath,staged);
          ArtworkMutationJournal.publish(intentId);
        }
        db.transaction(() => {
          const row = db.prepare("SELECT id FROM MetadataFiles WHERE file_path = ? AND file_type IN ('cover','artwork','video_thumbnail','video_cover')")
            .get(options.outputPath) as { id: number } | undefined;
          rememberLibraryCoverSidecar(identity, getMediaCoverFolder(entityId, options.coverEntity), options.outputPath, hash, row?.id);
          if (source) storeArtworkSource(identity, { ...source, contentHash: hash });
          if (intentId) ArtworkMutationJournal.markCommitted(intentId);
        })();
        if (intentId) ArtworkMutationJournal.recoverOneSync(intentId);
      } catch (error) {
        if (intentId && ArtworkMutationJournal.hasPending()) {
          try {
            ArtworkMutationJournal.recoverOneSync(intentId);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], `Artwork replacement needs recovery; intent ${intentId} retained`);
          }
        }
        throw error;
      }
    }, "materialize selected library artwork");
  } finally {
    // Once intent exists, recovery owns its paths, including failed restores.
    if (!intentId) fs.rmSync(staged, { force: true });
  }
  return unchanged ? "unchanged" : "written";
}

