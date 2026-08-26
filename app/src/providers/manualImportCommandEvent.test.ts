import { describe, expect, it } from "vitest";
import { getManualImportTerminalNotice } from "./manualImportCommandEvent";

const event = (data: Record<string, unknown>) => ({
  type: "command.updated",
  data,
  timestamp: 1,
});

describe("manual import terminal command feedback", () => {
  it("ignores queued and running updates", () => {
    expect(getManualImportTerminalNotice(event({ type: "ImportUnmappedFiles", status: "queued" }))).toBeNull();
    expect(getManualImportTerminalNotice(event({ type: "ImportUnmappedFiles", status: "started" }))).toBeNull();
  });

  it("reports completion", () => {
    expect(getManualImportTerminalNotice(event({ type: "ImportUnmappedFiles", status: "completed" }))).toEqual({
      title: "Manual import completed",
      description: "The queued import finished. Check Activity for details.",
    });
  });

  it("surfaces the worker error on failure", () => {
    expect(getManualImportTerminalNotice(event({
      type: "ImportUnmappedFiles",
      status: "failed",
      error: "FOREIGN KEY constraint failed",
    }))).toEqual({
      title: "Manual import failed",
      description: "FOREIGN KEY constraint failed",
      variant: "destructive",
    });
  });

  it("ignores terminal updates for other commands", () => {
    expect(getManualImportTerminalNotice(event({ type: "DownloadAlbum", status: "failed" }))).toBeNull();
  });
});
