import path from "node:path";

/**
 * Provider resource ids are opaque identifiers, but download workspaces use
 * them as one filesystem segment. Reject separators and platform-reserved
 * characters rather than silently changing an id into a different identity.
 */
export function assertSafeDownloadResourceId(value: unknown): string {
    const id = String(value ?? "").trim();
    if (!id || id.length > 512) {
        throw new Error("Provider resource ID must contain between 1 and 512 characters.");
    }
    const hasControlCharacter = Array.from(id).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (id === "." || id === ".." || hasControlCharacter || /[<>:"/\\|?*]/u.test(id)) {
        throw new Error("Provider resource ID contains unsafe path characters.");
    }
    if (/[. ]$/u.test(id)) {
        throw new Error("Provider resource ID cannot end in a dot or space.");
    }
    return id;
}

/** Resolve a candidate beneath a trusted root and reject the root itself. */
export function assertPathInsideRoot(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (
        !relative
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new Error("Download workspace must stay inside the configured download root.");
    }
    return resolvedCandidate;
}

export function safeProviderMediaFilename(providerId: unknown, extension: string): string {
    return `${assertSafeDownloadResourceId(providerId)}${extension}`;
}
