import { MusicBrainzReleaseSelectionService } from "./musicbrainz-release-selection-service.js";
import type { ProviderReleaseGroupMatch } from "./provider-release-group-matcher.js";

function normalizeReleaseMbids(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return Array.from(new Set(
        values
            .map((value) => String(value || "").trim())
            .filter(Boolean),
    ));
}

export class ProviderOfferReleaseLinkService {
    static selectReleaseMbid(match?: ProviderReleaseGroupMatch | null): string | null {
        if (!match || match.status === "unmatched") {
            return null;
        }

        const directReleaseMbid = String(match.releaseMbid || "").trim();
        if (directReleaseMbid) {
            return directReleaseMbid;
        }

        const matchedReleaseMbid = String(match.evidence?.matchedReleaseMbid || "").trim();
        if (matchedReleaseMbid) {
            return matchedReleaseMbid;
        }

        const releaseGroupMbid = String(match.releaseGroup?.mbid || "").trim();
        const availableReleaseMbids = normalizeReleaseMbids(match.evidence?.availableReleaseMbids);
        if (!releaseGroupMbid || availableReleaseMbids.length === 0) {
            return null;
        }

        const selected = MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid, {
            availableReleaseMbids,
        });
        return selected?.mbid || availableReleaseMbids[0] || null;
    }
}
