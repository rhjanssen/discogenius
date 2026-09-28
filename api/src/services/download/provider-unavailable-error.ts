/** A provider positively rejected an exact resource, rather than a network attempt. */
export class ProviderUnavailableError extends Error {
    constructor(
        readonly provider: string,
        readonly entityType: "track" | "album" | "video",
        readonly providerId: string,
        message: string,
    ) {
        super(message);
        this.name = "ProviderUnavailableError";
    }
}
