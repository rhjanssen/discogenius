import fs from "node:fs";
import path from "node:path";
import { Config } from "../config/config.js";
import type { ImportDecisionMode } from "../import-decision/types.js";
import {
    scanImportDirectory,
} from "./import-discovery.js";
import { importMatcherService } from "./import-matcher-service.js";
import type {
    AutoImportedGroupSummary,
    ImportCandidate,
    LocalGroup,
    ProviderMatch,
    RootFolderImportProgressEvent,
} from "./import-types.js";

export type {
    AutoImportedGroupSummary,
    ImportCandidate,
    LocalFile,
    LocalGroup,
    RootFolderImportProgressEvent,
    ProviderMatch,
} from "./import-types.js";

/**
 * Discovers existing files and proposes canonical catalogue identities for
 * review. Moving/registering files is intentionally delegated to the canonical
 * manual import services, where Library + Edition/Recording are explicit.
 */
export class ImportService {
    private candidates: ImportCandidate[] = [];

    async scanRootFolders(options: {
        monitorImported?: boolean;
        targetFolders?: Set<string>;
        onProgress?: (event: RootFolderImportProgressEvent) => void;
    } = {}): Promise<ImportCandidate[]> {
        void options.monitorImported;
        this.candidates = [];
        const roots = [
            { path: Config.getMusicPath(), context: "music" as const, libraryRoot: "music" as const },
            { path: Config.getSpatialPath(), context: "spatial" as const, libraryRoot: "spatial" as const },
            { path: Config.getVideoPath(), context: "video" as const, libraryRoot: "videos" as const },
        ];

        const scannedRoots: Array<{
            root: (typeof roots)[number];
            groups: LocalGroup[];
        }> = [];

        for (const root of roots) {
            try {
                const groups: LocalGroup[] = [];
                if (options.targetFolders && options.targetFolders.size > 0) {
                    for (const folderName of options.targetFolders) {
                        const actualName = await this.resolveActualFolderName(root.path, folderName);
                        if (!actualName) continue;
                        const subPath = path.join(root.path, actualName);
                        try {
                            await fs.promises.access(subPath);
                        } catch {
                            continue;
                        }
                        groups.push(...await scanImportDirectory(subPath, root.path, root.libraryRoot));
                    }
                } else {
                    groups.push(...await scanImportDirectory(root.path, root.path, root.libraryRoot));
                }
                scannedRoots.push({ root, groups });
            } catch (error) {
                console.error(`Failed to scan root ${root.path}:`, error);
            }
        }

        const totalFiles = scannedRoots.reduce(
            (sum, entry) => sum + entry.groups.reduce((groupSum, group) => groupSum + group.files.length, 0),
            0,
        );
        const totalGroups = scannedRoots.reduce((sum, entry) => sum + entry.groups.length, 0);
        let processedFiles = 0;
        let processedGroups = 0;

        options.onProgress?.({
            message: `Reading file 0/${totalFiles}`,
            currentFileNum: 0,
            totalFiles,
            currentGroupNum: 0,
            totalGroups,
        });

        for (const { root, groups } of scannedRoots) {
            const fileOffset = processedFiles;
            const groupOffset = processedGroups;
            const candidates = await this.findMatches(
                groups,
                root.context,
                {
                    onProgress: (event) => {
                        options.onProgress?.({
                            message: `Reading file ${fileOffset + event.currentFileNum}/${totalFiles}`,
                            currentFileNum: fileOffset + event.currentFileNum,
                            totalFiles,
                            currentGroupNum: groupOffset + event.currentGroupNum,
                            totalGroups,
                        });
                    },
                },
                "ExistingFiles",
            );
            this.candidates.push(...candidates);
            processedFiles += groups.reduce((sum, group) => sum + group.files.length, 0);
            processedGroups += groups.length;
        }

        return [...this.candidates];
    }

    getUnmapped(): ImportCandidate[] {
        return this.candidates.filter((candidate) => candidate.group.status !== "imported");
    }

    getAutoImported(): AutoImportedGroupSummary[] {
        return [];
    }

    async mapGroup(_groupId: string, _providerId: string): Promise<boolean> {
        throw new Error(
            "Provider-keyed group mapping was removed; use canonical Library + Edition/Recording import",
        );
    }

    async bulkImportUnmapped(_items: Array<{ id: number; providerId: string }>): Promise<never> {
        throw new Error(
            "Provider-keyed manual import was removed; use canonical MusicBrainz import",
        );
    }

    async findMatches(
        groups: LocalGroup[],
        context: "music" | "spatial" | "video" = "music",
        options?: { onProgress?: (event: RootFolderImportProgressEvent) => void },
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ImportCandidate[]> {
        return importMatcherService.findMatches(groups, context, options, mode);
    }

    async findMatchesForGroup(
        group: LocalGroup,
        context: "music" | "spatial" | "video" = "music",
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ProviderMatch[]> {
        return importMatcherService.findMatchesForGroup(group, context, mode);
    }

    private async resolveActualFolderName(
        rootPath: string,
        lowercaseName: string,
    ): Promise<string | null> {
        try {
            const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.toLowerCase() === lowercaseName) {
                    return entry.name;
                }
            }
        } catch {
            // Unreadable roots are reported by the caller as an empty scan.
        }
        return null;
    }
}

export const importService = new ImportService();
