export type ProviderResourceType = "artist" | "album" | "track" | "video";

export type ProviderResourceIdentity = {
  provider: string;
  type: ProviderResourceType;
  id: string;
};

function cleanId(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "apple" || normalized === "itunes") return "apple-music";
  // Discogenius registers one YouTube plugin (`youtube-music`); bare `youtube`
  // hostnames from MusicBrainz free-streaming links must resolve to it.
  if (normalized === "youtube" || normalized === "youtube music") return "youtube-music";
  return normalized;
}

function fromHostPath(hostname: string, pathname: string): ProviderResourceIdentity | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const parts = pathname.split("/").map((part) => part.trim()).filter(Boolean);

  if (host === "listen.tidal.com" || host === "tidal.com") {
    const offset = parts[0] === "browse" ? 1 : 0;
    const type = parts[offset] as ProviderResourceType | undefined;
    const id = cleanId(parts[offset + 1]);
    if ((type === "artist" || type === "album" || type === "track" || type === "video") && id) {
      return { provider: "tidal", type, id };
    }
  }

  if (host === "music.apple.com" || host === "itunes.apple.com") {
    const kind = parts.find((part) => part === "artist" || part === "album" || part === "song" || part === "music-video");
    const numericParts = parts
      .map((part) => part.match(/^\d+/)?.[0] || "")
      .filter(Boolean);
    const id = cleanId(numericParts[numericParts.length - 1]);
    if (kind && id) {
      return {
        provider: "apple-music",
        type: kind === "song" ? "track" : kind === "music-video" ? "video" : kind,
        id,
      };
    }
  }

  if (host === "open.spotify.com" || host === "play.spotify.com") {
    const type = parts[0] as ProviderResourceType | undefined;
    const id = cleanId(parts[1]);
    if ((type === "artist" || type === "album" || type === "track") && id) {
      return { provider: "spotify", type, id };
    }
  }

  if (host === "soundcloud.com") {
    const id = cleanId(parts.join("/"));
    if (id) {
      return { provider: "soundcloud", type: "track", id };
    }
  }

  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? cleanId(parts[0]) : "";
    if (id) {
      return { provider: "youtube-music", type: "video", id };
    }
  }

  return null;
}

export function parseProviderResourceIdentity(value?: string | null): ProviderResourceIdentity | null {
  const text = cleanId(value);
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const fromUrl = fromHostPath(url.hostname, url.pathname);
      if (fromUrl) return fromUrl;
      if ((url.hostname === "youtube.com" || url.hostname === "music.youtube.com" || url.hostname === "www.youtube.com") && url.searchParams.get("v")) {
        return {
          provider: "youtube-music",
          type: "video",
          id: cleanId(url.searchParams.get("v")),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  const typed = text.match(/^([a-z][a-z0-9_-]*):(?:([a-z][a-z0-9_-]*):)?(.+)$/i);
  if (typed?.[1] && typed[3]) {
    const provider = normalizeProvider(typed[1]);
    const rawType = typed[2]?.toLowerCase();
    const type = rawType === "artist" || rawType === "album" || rawType === "track" || rawType === "video"
      ? rawType
      : null;
    if (type) {
      return { provider, type, id: cleanId(typed[3]) };
    }
  }

  return null;
}

export function providerResourceKey(value?: string | null, fallback?: { provider?: string | null; type?: ProviderResourceType | null }): string {
  const parsed = parseProviderResourceIdentity(value);
  if (parsed) {
    return `${parsed.provider}:${parsed.type}:${parsed.id.toLowerCase()}`;
  }
  const provider = normalizeProvider(String(fallback?.provider || ""));
  const type = fallback?.type || null;
  const id = cleanId(value);
  if (provider && type && id && !/^https?:\/\//i.test(id)) {
    return `${provider}:${type}:${id.toLowerCase()}`;
  }
  return "";
}
