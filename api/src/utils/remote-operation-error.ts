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
  | "unclassified"
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
  unclassified: "Unclassified remote request",
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

/* ── Last resort ────────────────────────────────────────────────────── */

/** Axios and undici both produce this exact shape; neither names the service. */
const BARE_STATUS_MESSAGE = /^Request failed with status code (\d{3})$/i;

/**
 * Recover whatever provenance an unclassified client error still carries.
 *
 * Every call site should wrap its own failures — the service name and phase can
 * only come from there. But the source of the 503s in the 500-artist run is
 * still unidentified, so a message that reaches command history naming nothing
 * is a diagnostic opportunity spent. This is the net under that: it reads the
 * status, method and host off whatever error object arrived and produces
 * "Unclassified remote request: api.example.com returned HTTP 503".
 *
 * Returns null when there is genuinely nothing remote to report, so callers can
 * fall through to their own handling rather than mislabelling a local failure.
 */
export function normalizeUnclassifiedRemoteError(error: unknown): RemoteOperationError | null {
  if (error instanceof RemoteOperationError) return error;
  if (error == null || typeof error !== "object") return null;

  const candidate = error as {
    message?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    config?: { url?: unknown; method?: unknown; baseURL?: unknown };
    request?: { host?: unknown; method?: unknown; path?: unknown };
  };

  const statusFromResponse = Number(candidate.response?.status ?? candidate.status);
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const statusFromMessage = Number(BARE_STATUS_MESSAGE.exec(message)?.[1]);
  const status = Number.isFinite(statusFromResponse) && statusFromResponse > 0
    ? statusFromResponse
    : (Number.isFinite(statusFromMessage) ? statusFromMessage : null);
  if (status == null) return null;

  const rawUrl = typeof candidate.config?.url === "string" ? candidate.config.url : null;
  const baseUrl = typeof candidate.config?.baseURL === "string" ? candidate.config.baseURL : null;
  const method = typeof candidate.config?.method === "string"
    ? candidate.config.method.toUpperCase()
    : (typeof candidate.request?.method === "string" ? candidate.request.method : null);

  // Host and path only. A query string routinely carries an api key, and this
  // string is persisted into command history.
  let host: string | null = typeof candidate.request?.host === "string"
    ? candidate.request.host
    : null;
  let pathname: string | null = null;
  for (const url of [rawUrl, baseUrl]) {
    if (!url) continue;
    try {
      const parsed = new URL(url, baseUrl ?? undefined);
      host = host ?? parsed.host;
      pathname = pathname ?? parsed.pathname;
      break;
    } catch {
      // Relative URL with no base: keep the path, drop any query.
      if (!pathname && url.startsWith("/")) pathname = url.split("?")[0];
    }
  }

  return new RemoteOperationError(
    {
      phase: "unclassified",
      service: host ?? "an unnamed host",
      host,
      method,
      status,
      retryable: isTransientHttpStatus(status),
    },
    pathname ?? undefined,
    { cause: error },
  );
}
