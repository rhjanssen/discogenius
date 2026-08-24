/**
 * Ask provider CDNs for a compact image in dense picker/list contexts.
 * Unknown URL shapes pass through unchanged rather than risking a broken image.
 */
export function providerArtworkThumbnailUrl(
    providerId: string | null | undefined,
    source: string | null | undefined,
    size = 160,
): string | undefined {
    const url = String(source || "").trim();
    if (!url) return undefined;

    const provider = String(providerId || "").trim().toLowerCase();
    if (provider === "tidal" && /^https:\/\/resources\.tidal\.com\/images\//i.test(url)) {
        return url.replace(/\/(?:origin|\d+x\d+)\.jpg(?=\?|$)/i, `/${size}x${size}.jpg`);
    }

    if (provider === "deezer") {
        return url.replace(/\/\d+x\d+-/, `/${size}x${size}-`);
    }

    if (provider === "apple-music") {
        return url
            .replace(/\{w\}x\{h\}/gi, `${size}x${size}`)
            .replace(/\/\d+x\d+([a-z]*)\.(?:jpg|jpeg|png)(?=\?|$)/i, (_match, suffix: string) => `/${size}x${size}${suffix}.jpg`);
    }

    return url;
}
