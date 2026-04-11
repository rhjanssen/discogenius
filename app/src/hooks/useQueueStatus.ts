import { useContext } from "react";
import { QueueStatusContext } from "@/providers/queueStatusContext";

export function useQueueStatus() {
  const context = useContext(QueueStatusContext);
  if (!context) {
    throw new Error("useQueueStatus must be used within a QueueStatusProvider");
  }

  return context;
}
