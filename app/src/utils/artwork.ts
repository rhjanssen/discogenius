/**
 * Unified frontend cover-art helper. Prefer cover_art_url (local /media-cover),
 * then legacy cover/cover_id aliases, then artist picture fields.
 * Raw provider asset UUIDs are dropped by renderableArtworkUrl.
 *
 * Cover identity model (Lidarr-like):
 * - API emits one stable path per entity + cover type: `/media-cover/.../cover.jpg`
 *   plus optional `?source=` (album/artist preference) and `?lastWrite=` (file mtime).
 * - Cards may rewrite the filename to a height proxy (`cover-250.jpg` / `cover-500.jpg`)
 *   but must preserve the query string so list and detail share the same generation.
 * - Detail pages use the bare identity URL (origin for videos; route remaps albums).
 */
export function renderableArtworkUrl(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  if (/^(https?:\/\/|\/|data:|blob:)/i.test(text)) {
    return text;
  }

  return null;
}

export type MediaCoverEntity = {
  cover_art_url?: string | null;
  cover?: string | null;
  cover_id?: string | null;
  picture?: string | null;
  cover_image_url?: string | null;
  imageId?: string | null;
};

export function mediaCoverSrc(entity: MediaCoverEntity | null | undefined): string | null {
  if (!entity) {
    return null;
  }

  return renderableArtworkUrl(
    entity.cover_art_url
      ?? entity.cover
      ?? entity.cover_id
      ?? entity.picture
      ?? entity.cover_image_url
      ?? entity.imageId,
  );
}

function defaultProxyHeightForPath(pathname: string): 500 | 250 {
  // Videos keep a single small card proxy (250) beside full-res origin.
  // Album/artist UI cache still generates 500 + 250.
  return pathname.includes("/media-cover/Videos/") ? 250 : 500;
}

/**
 * Rewrite a local `/media-cover/.../cover.jpg` URL to the height-named proxy
 * while preserving `?source=` / `?lastWrite=` so list and detail stay on the
 * same cover generation. Proxies preserve source aspect (no forced 3:2 crop).
 * Remote/data URLs pass through.
 */
export function toMediaCoverProxyUrl(
  url: string,
  height?: 500 | 250,
): string {
  const text = String(url || "").trim();
  if (!text) {
    return text;
  }

  try {
    const isAbsolute = /^https?:\/\//i.test(text);
    const parsed = isAbsolute ? new URL(text) : null;
    const pathname = parsed ? parsed.pathname : text.split(/[?#]/, 1)[0];
    if (!pathname.startsWith("/media-cover/")) {
      return text;
    }

    const resolvedHeight = height ?? defaultProxyHeightForPath(pathname);
    const rewritten = pathname.replace(
      /\/([^/]+?)(?:-\d+)?(\.[a-z0-9]+)$/i,
      `/$1-${resolvedHeight}$2`,
    );
    if (parsed) {
      parsed.pathname = rewritten;
      return parsed.toString();
    }
    return rewritten + text.slice(pathname.length);
  } catch {
    return text;
  }
}

/** Card/list artwork: height proxy of the same cover identity as mediaCoverSrc. */
export function mediaCoverProxySrc(
  entity: MediaCoverEntity | null | undefined,
  height?: 500 | 250,
): string | null {
  const src = mediaCoverSrc(entity);
  return src ? toMediaCoverProxyUrl(src, height) : null;
}
