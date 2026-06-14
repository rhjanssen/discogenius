// Central registry of streaming-provider brand marks. TIDAL ships a white
// monochrome glyph, so it renders as a theme-tinted mask and stays visible on
// both light and dark surfaces; every other provider has a full-colour logo and
// renders as a plain image. Keys cover the hyphenated and underscored ids we
// persist. Flag another provider `monochrome: true` if its asset is single-tone.

export type ProviderMarkAsset = { src: string; monochrome: boolean };

const PROVIDER_MARKS: Record<string, ProviderMarkAsset> = {
    tidal: { src: "/assets/images/tidal_icon.svg", monochrome: true },
    apple: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    apple_music: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    "apple-music": { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    amazon: { src: "/assets/images/amazon_icon.svg", monochrome: false },
    spotify: { src: "/assets/images/spotify_icon.svg", monochrome: false },
    youtube: { src: "/assets/images/youtube_icon.svg", monochrome: false },
    deezer: { src: "/assets/images/deezer_icon.svg", monochrome: false },
};

export function providerKey(provider?: string | null): string {
    return String(provider || "").trim().toLowerCase();
}

export function providerMarkFor(provider?: string | null): ProviderMarkAsset | undefined {
    const key = providerKey(provider);
    return PROVIDER_MARKS[key] || PROVIDER_MARKS[key.replace(/-/g, "_")];
}
