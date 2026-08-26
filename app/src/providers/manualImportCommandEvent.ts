import type { GlobalEventPayload } from "@/hooks/useGlobalEvents";

export type ManualImportTerminalNotice = {
  title: string;
  description: string;
  variant?: "destructive";
};

type ManualImportCommandData = {
  type?: unknown;
  status?: unknown;
  error?: unknown;
};

/** Translate only terminal manual-import command events into user feedback. */
export function getManualImportTerminalNotice(
  event: GlobalEventPayload,
): ManualImportTerminalNotice | null {
  if (event.type !== "command.updated" || !event.data || typeof event.data !== "object") {
    return null;
  }

  const data = event.data as ManualImportCommandData;
  if (data.type !== "ImportUnmappedFiles") {
    return null;
  }

  if (data.status === "completed") {
    return {
      title: "Manual import completed",
      description: "The queued import finished. Check Activity for details.",
    };
  }
  if (data.status === "failed") {
    return {
      title: "Manual import failed",
      description: typeof data.error === "string" && data.error.trim()
        ? data.error
        : "The queued import could not be completed. Check Activity for details.",
      variant: "destructive",
    };
  }
  if (data.status === "cancelled") {
    return {
      title: "Manual import cancelled",
      description: "The queued import was cancelled.",
      variant: "destructive",
    };
  }

  return null;
}
