import { describe, expect, it, vi } from "vitest";
import { buildArtistOverflowActions } from "./artistOverflowActions";

function actions() {
  return buildArtistOverflowActions(
    {
      isScanBusy: false,
      isCurateBusy: false,
      hasAlbums: true,
      downloadActionDisabled: false,
      renameApplying: false,
      retagApplying: false,
      stripTagsApplying: false,
      deleteFilesApplying: false,
    },
    {
      syncArtist: vi.fn(),
      curateArtist: vi.fn(),
      startDownloads: vi.fn(),
      openRenamePreview: vi.fn(),
      openRetagPreview: vi.fn(),
      openStripTags: vi.fn(),
      openDeleteFiles: vi.fn(),
    },
  );
}

describe("artist overflow actions", () => {
  it("does not duplicate monitoring policy actions", () => {
    const result = actions();
    expect(result.map((action) => action.key)).not.toEqual(
      expect.arrayContaining(["monitor", "pause", "resume", "new-releases", "unmonitor"]),
    );
  });

  it("does not offer deletion of the artist record", () => {
    const result = actions();
    expect(result.map((action) => action.key)).not.toContain("delete-artist");
    expect(result.map((action) => action.label)).not.toContain("Delete artist...");
  });
});
