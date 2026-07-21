/**
 * Unified frontend cover-art helper. Prefer cover_art_url (local /media-cover),
 * then legacy cover/cover_id aliases, then artist picture fields.
 * Raw provider asset UUIDs are dropped by renderableArtworkUrl.
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
