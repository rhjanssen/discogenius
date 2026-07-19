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
 * Public web URL for a provider album id, for "open on the streaming service"
 * links. Apple uses the geo redirect host so the user's storefront resolves
 * client-side. Returns null for providers without a stable public album URL.
 */
export function providerAlbumUrl(provider: string | null | undefined, albumId: string): string | null {
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
    return null;
}

/** Public web URL for a provider music-video id (same contract as providerAlbumUrl). */
export function providerVideoUrl(provider: string | null | undefined, videoId: string): string | null {
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
