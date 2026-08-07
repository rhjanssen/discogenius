/**
 * Structured provenance for remote failures.
 *
 * The 500-artist run recorded, in command history, only:
 *
 *     Request failed with status code 503
 *
 * That is a client library's default message. It names no service, no host, no
 * phase and no entity, so the only way to find out which dependency was failing
 * was to guess — the artwork service, a provider API, and the metadata server
 * were all equally consistent with it.
 *
 * Every remote operation should fail with one of these instead, so the next
 * import says which dependency broke and during what.
 */

/** The refresh/matching phase a call belongs to. Free-form but conventional. */
export type RemotePhase =
  | "canonical.artist"
  | "canonical.release-groups"
  | "canonical.recording"
  | "artist-artwork"
  | "album-artwork"
  | "biography"
  | "provider.search"
  | "provider.album"
  | "provider.track"
  | "provider.video"
  | "video.enrichment";

export interface RemoteOperationContext {
  phase: RemotePhase;
  /** The dependency, as an operator would name it: "cover-art-archive". */
  service: string;
  host?: string | null;
  method?: string | null;
  status?: number | null;
  retryable?: boolean;
  artistMbid?: string | null;
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  provider?: string | null;
}

/** Human phase names, so history reads as prose rather than as dotted keys. */
const PHASE_LABELS: Record<RemotePhase, string> = {
  "canonical.artist": "Artist metadata",
  "canonical.release-groups": "Discography metadata",
  "canonical.recording": "Recording metadata",
  "artist-artwork": "Artist artwork",
  "album-artwork": "Album artwork",
  biography: "Artist biography",
  "provider.search": "Provider search",
  "provider.album": "Provider album lookup",
  "provider.track": "Provider track lookup",
  "provider.video": "Provider video lookup",
  "video.enrichment": "Video enrichment",
};

export class RemoteOperationError extends Error {
  readonly context: RemoteOperationContext;

  constructor(context: RemoteOperationContext, detail?: string, options?: { cause?: unknown }) {
    super(RemoteOperationError.describe(context, detail), options);
    this.name = "RemoteOperationError";
    this.context = context;
  }

  get retryable(): boolean {
    return this.context.retryable === true;
  }

  /**
   * "Album artwork: cover-art-archive returned HTTP 503" — the phase, the
   * dependency and what it did, in that order, because that is the order an
   * operator asks the questions in.
   */
  private static describe(context: RemoteOperationContext, detail?: string): string {
    const outcome = context.status != null
      ? `returned HTTP ${context.status}`
      : (detail || "failed");
    const head = `${PHASE_LABELS[context.phase] ?? context.phase}: ${context.service} ${outcome}`;
    return context.status != null && detail ? `${head} (${detail})` : head;
  }
}

/**
 * Wrap whatever a client threw, keeping its message as detail.
 *
 * Deliberately preserves an existing `RemoteOperationError` untouched: the
 * innermost caller knows the most about what it was doing, and re-wrapping
 * would bury it behind a vaguer outer phase.
 */
export function asRemoteOperationError(
  error: unknown,
  context: RemoteOperationContext,
): RemoteOperationError {
  if (error instanceof RemoteOperationError) return error;
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return new RemoteOperationError(context, detail || undefined, { cause: error });
}

/** Status codes worth retrying: transient by definition, not by hope. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429
    || (status >= 500 && status <= 599);
}

/**
 * Run a remote operation, tagging any failure with where it happened.
 *
 * `status` is filled in by the caller when it has a response; everything else
 * is fixed per call site, so adopting this is a one-line change.
 */
export async function withRemoteContext<T>(
  context: RemoteOperationContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asRemoteOperationError(error, context);
  }
}
