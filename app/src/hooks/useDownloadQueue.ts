import { useContext } from "react";
import { QueueContext, QueueItem, DownloadProgress } from "@/providers/QueueProvider";

export type { QueueItem, DownloadProgress };

export const useDownloadQueue = () => {
  const context = useContext(QueueContext);
  if (context === undefined) {
    throw new Error("useDownloadQueue must be used within a QueueProvider");
  }
  return context;
};

