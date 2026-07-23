// Central registry of streaming-provider brand marks. TIDAL ships a white
// monochrome glyph, so it renders as a theme-tinted mask and stays visible on
// both light and dark surfaces; every other provider has a full-colour logo and
// renders as a plain image. Keys cover the hyphenated and underscored ids we
// persist. Flag another provider `monochrome: true` if its asset is single-tone.

// `badgeFill: true` marks logos that carry their own coloured background
// (Apple's red squircle, Spotify's green disc, YouTube Music's red disc):
// inside a circular provider badge they should fill the whole circle instead
// of floating as a small glyph. Glyph-style marks (TIDAL, Deezer, Amazon)
// stay centred on the badge surface at glyph size.
export type ProviderMarkAsset = { src: string; monochrome: boolean; badgeFill?: boolean };

const PROVIDER_MARKS: Record<string, ProviderMarkAsset> = {
    tidal: { src: "/assets/images/tidal_icon.svg", monochrome: true },
    apple: { src: "/assets/images/apple_music_icon.svg", monochrome: false, badgeFill: true },
    apple_music: { src: "/assets/images/apple_music_icon.svg", monochrome: false, badgeFill: true },
    "apple-music": { src: "/assets/images/apple_music_icon.svg", monochrome: false, badgeFill: true },
    amazon: { src: "/assets/images/amazon_icon.svg", monochrome: false },
    amazon_music: { src: "/assets/images/amazon_icon.svg", monochrome: false },
    "amazon-music": { src: "/assets/images/amazon_icon.svg", monochrome: false },
    spotify: { src: "/assets/images/spotify_icon.svg", monochrome: false, badgeFill: true },
    youtube: { src: "/assets/images/youtube_icon.svg", monochrome: false, badgeFill: true },
    youtube_music: { src: "/assets/images/youtube_icon.svg", monochrome: false, badgeFill: true },
    "youtube-music": { src: "/assets/images/youtube_icon.svg", monochrome: false, badgeFill: true },
    deezer: { src: "/assets/images/deezer_icon.svg", monochrome: false },
    soundcloud: { src: "/assets/images/soundcloud_icon.svg", monochrome: false, badgeFill: true },
};

export function providerKey(provider?: string | null): string {
    let key = String(provider || "").trim().toLowerCase();
    if (key === "amazon_music" || key === "amazon-music") key = "amazon";
    if (key === "apple_music" || key === "apple-music") key = "apple";
    if (key === "youtube_music" || key === "youtube-music") key = "youtube";
    return key;
}

export function providerMarkFor(provider?: string | null): ProviderMarkAsset | undefined {
    const key = providerKey(provider);
    return PROVIDER_MARKS[key] || PROVIDER_MARKS[key.replace(/-/g, "_")];
}

/**
 * Provider URLs come from adapter-owned catalog responses and are persisted
 * with the offer. Keep those canonical/permalink URLs authoritative, but never
 * put an unsafe or credential-bearing value into an anchor.
 */
function isProviderLinkHost(provider: string | null | undefined, hostname: string): boolean {
    const key = providerKey(provider);
    const host = hostname.toLowerCase().replace(/\.$/u, "");
    const isDomain = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    if (key === "tidal") return isDomain("tidal.com");
    if (key === "apple") return isDomain("music.apple.com");
    if (key === "amazon") return isDomain("amazon.com");
    if (key === "spotify") return isDomain("spotify.com");
    if (key === "youtube") return isDomain("youtube.com") || host === "youtu.be";
    if (key === "deezer") return isDomain("deezer.com");
    if (key === "soundcloud") return isDomain("soundcloud.com");
    return false;
}

export function validatedProviderUrl(
    provider: string | null | undefined,
    providerUrl?: string | null,
): string | null {
    const value = String(providerUrl || "").trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== "https:"
            || parsed.username
            || parsed.password
            || !isProviderLinkHost(provider, parsed.hostname)
        ) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

/**
 * Public web URL for a provider album id, for "open on the streaming service"
 * links. Apple uses the geo redirect host so the user's storefront resolves
 * client-side. A validated adapter-supplied URL wins because some services
 * (notably SoundCloud) cannot construct a working public permalink from an id.
 * Returns null for providers without either form.
 */
export function providerAlbumUrl(
    provider: string | null | undefined,
    albumId: string,
    providerUrl?: string | null,
): string | null {
    const stored = validatedProviderUrl(provider, providerUrl);
    if (stored) return stored;
    const id = String(albumId || "").trim();
    if (!id) return null;
    const key = providerKey(provider);
    if (key === "tidal") return `https://tidal.com/browse/album/${encodeURIComponent(id)}`;
    if (key.startsWith("apple")) return `https://geo.music.apple.com/album/${encodeURIComponent(id)}`;
    if (key === "amazon-music" || key === "amazon_music" || key === "amazon") {
        return `https://music.amazon.com/albums/${encodeURIComponent(id)}`;
    }
    if (key === "spotify") return `https://open.spotify.com/album/${encodeURIComponent(id)}`;
    if (key === "youtube-music" || key === "youtube_music" || key === "youtube") {
        return /^(?:OLAK5uy_|PL|RD)/u.test(id)
            ? `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`
            : `https://music.youtube.com/browse/${encodeURIComponent(id)}`;
    }
    if (key === "deezer") return `https://www.deezer.com/album/${encodeURIComponent(id)}`;
    // SoundCloud numeric playlist ids are stable acquisition identity, but
    // soundcloud.com has no working public /playlists/<id> route. Only a
    // persisted permalink can be linked safely.
    if (key === "soundcloud") return null;
    return null;
}

/** Public web URL for a provider track id (same contract as providerAlbumUrl). */
export function providerTrackUrl(
    provider: string | null | undefined,
    trackId: string,
    providerUrl?: string | null,
): string | null {
    const stored = validatedProviderUrl(provider, providerUrl);
    if (stored) return stored;
    const id = String(trackId || "").trim();
    if (!id) return null;
    const key = providerKey(provider);
    if (key === "tidal") return `https://tidal.com/browse/track/${encodeURIComponent(id)}`;
    if (key.startsWith("apple")) return `https://geo.music.apple.com/song/${encodeURIComponent(id)}`;
    if (key === "amazon-music" || key === "amazon_music" || key === "amazon") {
        return `https://music.amazon.com/tracks/${encodeURIComponent(id)}`;
    }
    if (key === "spotify") return `https://open.spotify.com/track/${encodeURIComponent(id)}`;
    if (key === "youtube-music" || key === "youtube_music" || key === "youtube") {
        return `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    if (key === "deezer") return `https://www.deezer.com/track/${encodeURIComponent(id)}`;
    // As with sets, a numeric track id does not form a public SoundCloud
    // permalink. The adapter-captured provider URL is required.
    if (key === "soundcloud") return null;
    return null;
}

/** Public web URL for a provider music-video id (same contract as providerAlbumUrl). */
export function providerVideoUrl(
    provider: string | null | undefined,
    videoId: string,
    providerUrl?: string | null,
): string | null {
    const stored = validatedProviderUrl(provider, providerUrl);
    if (stored) return stored;
    const id = String(videoId || "").trim();
    if (!id) return null;
    const key = providerKey(provider);
    if (key === "tidal") return `https://tidal.com/browse/video/${encodeURIComponent(id)}`;
    if (key.startsWith("apple")) return `https://geo.music.apple.com/music-video/${encodeURIComponent(id)}`;
    if (key === "youtube-music" || key === "youtube_music" || key === "youtube") {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    return null;
}
