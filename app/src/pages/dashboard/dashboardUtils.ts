import {
    ArrowSync24Regular,
    ArrowDownload24Regular,
    ArrowSortDownLines24Regular,
    ArrowUp24Regular,
    Broom24Regular,
    FolderSearch24Regular,
    MusicNote224Regular,
    Settings24Regular,
} from "@fluentui/react-icons";
import { tokens } from "@fluentui/react-components";
import { createElement } from "react";

type JobLike = {
    type?: string;
    status?: string;
    endTime?: number | string | null;
    description?: string;
    payload?: unknown;
    error?: string;
};

function getJobPayload(job: JobLike): Record<string, any> | null {
    if (!job?.payload) return null;
    if (typeof job.payload === "string") {
        try {
            return JSON.parse(job.payload);
        } catch {
            return null;
        }
    }
    return typeof job.payload === "object" ? job.payload as Record<string, any> : null;
}

function isActiveJob(job: JobLike): boolean {
    return job?.status === "running" || job?.status === "processing";
}

function humanizeJobType(type: string): string {
    return type
        .replace(/_/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeDescription(description: string): string {
    return description
        .replace(/^Download(Album|Track|Video|Playlist):\s*/i, "")
        .replace(/^ImportDownload:\s*/i, "")
        .replace(/^(Downloading|Upgrading|Importing|Processing|Refreshing|Scanning|Curating|Cleaning Up)\s+/i, "")
        .replace(/^(Monitoring|Library refresh|Library scan|Metadata refresh|Curation):\s*/i, "")
        .replace(/^album:\s*/i, "Album: ")
        .replace(/^track:\s*/i, "Track: ")
        .replace(/^video:\s*/i, "Video: ")
        .replace(/^playlist:\s*/i, "Playlist: ")
        .replace(/^artist:\s*/i, "Artist: ")
        .trim();
}

function splitWorkflowDescription(description: string) {
    const trimmed = description.trim();
    if (!trimmed) {
        return { subject: "", detail: "" };
    }

    const [subject, ...rest] = trimmed.split(/\s+-\s+/);
    return {
        subject: subject.trim(),
        detail: rest.join(" - ").trim(),
    };
}

function ensureLabeled(label: string, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const prefix = new RegExp(`^${label}:`, "i");
    if (prefix.test(trimmed)) {
        return trimmed.replace(prefix, `${label}:`);
    }
    return `${label}: ${trimmed}`;
}

function stripLabel(label: string, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.replace(new RegExp(`^${label}:\\s*`, "i"), "").trim();
}

function summarizeQueuedDownloads(description: string): string {
    const trimmed = description.trim();
    const match = trimmed.match(/^Queued\s+(\d+)\s+download\(s\)\s*(\(.+\))$/i);
    if (!match) {
        return trimmed;
    }

    return `${match[1]} total ${match[2]}`;
}

function joinSubject(title: string, artist?: string, album?: string): string {
    const parts = [title];
    if (album) parts.push(`on ${album}`);
    if (artist) parts.push(`by ${artist}`);
    return parts.filter(Boolean).join(" ");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function getImportDownloadLabel(job: JobLike): string {
    const payload = getJobPayload(job);
    switch (payload?.type) {
        case "album":
            return "Import Album";
        case "track":
            return "Import Track";
        case "video":
            return "Import Video";
        default:
            return "Import Download";
    }
}

export function formatJobType(job: JobLike): string {
    if (!job) return "Unknown Job";

    const type = job.type || "";

    switch (type) {
        case "DownloadAlbum":
            return "Download Album";
        case "DownloadTrack":
            return "Download Track";
        case "DownloadVideo":
            return "Download Video";
        case "DownloadPlaylist":
            return "Download Playlist";
        case "ImportDownload":
            return getImportDownloadLabel(job);
        case "ImportPlaylist":
            return "Import Playlist";
        case "RefreshArtist":
            return "Refresh Artist";
        case "RefreshMetadata":
            return "Refresh Metadata";
        case "ApplyCuration":
            return "Apply Curation";
        case "DownloadMissing":
            return "Queue Downloads";
        case "CheckUpgrades":
            return "Check Upgrades";
        case "Housekeeping":
            return "Run Housekeeping";
        case "ScanAlbum":
            return "Scan Album";
        case "ScanPlaylist":
            return "Scan Playlist";
        case "RescanFolders": {
            const rescanPayload = getJobPayload(job);
            return rescanPayload?.addNewArtists ? "Scan Library" : "Rescan Folders";
        }
        case "CurateArtist":
            return "Curate Artist";
        case "ConfigPrune":
            return "Prune Library Files";
        case "ApplyRenames":
            return "Apply Renames";
        case "ApplyRetags":
            return "Apply Retags";
        default:
            return humanizeJobType(type);
    }
}

export function formatJobDescription(job: JobLike): string {
    if (!job) return "";

    const type = job.type || "";
    const payload = getJobPayload(job);
    const resolved = payload?.resolved || null;
    const title = resolved?.title || payload?.title || payload?.playlistName || "";
    const artist = resolved?.artist || payload?.artist || payload?.artistName || "";
    const album = payload?.albumTitle || payload?.album || resolved?.albumTitle || "";
    const desc = normalizeDescription(job.description || "");

    switch (type) {
        case "DownloadAlbum":
            return title ? joinSubject(title, artist) : stripLabel("Album", desc);
        case "DownloadTrack":
            return title ? joinSubject(title, artist, album) : stripLabel("Track", desc);
        case "DownloadVideo":
            return title ? joinSubject(title, artist) : stripLabel("Video", desc);
        case "DownloadPlaylist":
            return title || stripLabel("Playlist", desc);
        case "ImportDownload": {
            const importedType = payload?.type;
            if (importedType === "album") return joinSubject(title, artist) || stripLabel("Album", desc);
            if (importedType === "track") return joinSubject(title, artist, album) || stripLabel("Track", desc);
            if (importedType === "video") return joinSubject(title, artist) || stripLabel("Video", desc);
            if (payload?.files?.length) return `Imported ${pluralize(payload.files.length, "file")}`;
            return desc || "Imported files from a completed download";
        }
        case "ImportPlaylist":
            return title || stripLabel("Playlist", desc) || "Imported playlist files";
        case "RefreshArtist":
        case "CurateArtist":
        case "RescanFolders": {
            if (type === "RescanFolders" && payload?.addNewArtists) {
                if (isActiveJob(job) && desc) {
                    const workflowDescription = splitWorkflowDescription(desc);
                    const detail = workflowDescription.detail;
                    if (detail) {
                        return `All root folders · ${detail}`;
                    }
                    return desc;
                }
                return "All root folders";
            }
            const workflowDescription = splitWorkflowDescription(desc);
            const subject = artist || workflowDescription.subject;
            const detail = workflowDescription.detail;
            if (subject && detail) {
                return `${subject} · ${detail}`;
            }
            if (subject) {
                return subject;
            }
            return detail || "Managed library task";
        }
        case "ScanAlbum":
            return title ? joinSubject(title, artist) : stripLabel("Album", desc);
        case "ScanPlaylist":
            return title || stripLabel("Playlist", desc) || "Playlist";
        case "RefreshMetadata":
        case "ApplyCuration":
        case "DownloadMissing":
        case "CheckUpgrades": {
            const workflowDescription = splitWorkflowDescription(desc);
            const subject = workflowDescription.subject;
            const detail = workflowDescription.detail;
            if (subject && detail) {
                return `${subject} · ${detail}`;
            }
            if (subject) {
                return type === "DownloadMissing" ? summarizeQueuedDownloads(subject) : subject;
            }

            if (type === "RefreshMetadata") return desc || "TIDAL metadata cache";
            if (type === "ApplyCuration") return desc || "Release monitoring and inclusion rules";
            if (type === "DownloadMissing") return summarizeQueuedDownloads(desc) || "Monitored library items";
            return desc || "Quality profile upgrades";
        }
        case "Housekeeping":
            return "Library maintenance and cleanup";
        case "ConfigPrune":
            return "Pruning stale library file records";
        case "ApplyRenames":
            return desc || "Applying the current library naming plan";
        case "ApplyRetags":
            return desc || "Applying configured audio metadata tags";
        default:
            return desc;
    }
}

export function formatRelativeTime(value?: number | string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const now = Date.now();
    let diffMs = now - date.getTime();
    if (diffMs < 0) diffMs = 0;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

export function matchesActivityFilter(job: any, filter: string): boolean {
    if (filter === 'all') return true;

    const type = job?.type || '';

    switch (filter) {
        case 'downloads':
            return [
                'DownloadAlbum',
                'DownloadTrack',
                'DownloadVideo',
                'DownloadPlaylist',
                'DownloadMissing',
                'CheckUpgrades',
            ].includes(type);
        case 'imports':
            return type === 'ImportDownload' || type === 'ImportPlaylist';
        case 'metadata':
            return [
                'RefreshArtist',
                'RefreshMetadata',
                'RescanFolders',
                'ScanAlbum',
                'ScanPlaylist',
                'ApplyRenames',
                'ApplyRetags',
            ].includes(type);
        case 'curation':
            return [
                'ApplyCuration',
                'CurateArtist',
            ].includes(type);
        default:
            return type.includes(filter);
    }
}

const iconStyle = { width: 16, height: 16, color: tokens.colorNeutralForeground3 };

export function getActivityTypeIcon(job: any) {
    const type = job?.type || '';
    const payload = getJobPayload(job);

    if (type.startsWith('Download')) {
        if (payload?.reason === 'upgrade') {
            return createElement(ArrowUp24Regular, { style: { ...iconStyle, color: tokens.colorPaletteBlueForeground2 } });
        }
        return createElement(ArrowDownload24Regular, { style: iconStyle });
    }
    if (type === 'RefreshArtist' || type === 'ScanAlbum') {
        return createElement(FolderSearch24Regular, { style: iconStyle });
    }
    if (type === 'RescanFolders') {
        return payload?.addNewArtists
            ? createElement(FolderSearch24Regular, { style: iconStyle })
            : createElement(MusicNote224Regular, { style: iconStyle });
    }
    if (type === 'Housekeeping') {
        return createElement(Broom24Regular, { style: iconStyle });
    }
    if (type === 'ConfigPrune') {
        return createElement(Settings24Regular, { style: iconStyle });
    }
    if (type === 'ApplyCuration' || type === 'CurateArtist') {
        return createElement(ArrowSortDownLines24Regular, { style: iconStyle });
    }
    return createElement(ArrowSync24Regular, { style: iconStyle });
}
