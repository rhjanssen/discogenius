import { Router } from "express";
import { appEvents, AppEvent } from "../services/app-events.js";
import type { AppEventPayloadMap } from "../services/app-events.js";

const router = Router();

router.get("/", (req, res) => {
    // Setup SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    });

    // Flush headers immediately
    res.write('\n');

    // Generic event forwarder
    const forwardEvent = <K extends AppEvent>(eventType: K, payload?: AppEventPayloadMap[K]) => {
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
    };

    const removeListeners: Array<() => void> = [];

    const bindEvent = <K extends AppEvent>(eventType: K) => {
        const listener = (payload: AppEventPayloadMap[K]) => forwardEvent(eventType, payload);
        appEvents.on(eventType, listener);
        removeListeners.push(() => appEvents.off(eventType, listener));
    };

    (Object.values(AppEvent) as AppEvent[]).forEach((eventType) => {
        bindEvent(eventType);
    });

    // Handle client disconnect
    req.on("close", () => {
        for (const removeListener of removeListeners) {
            removeListener();
        }
    });
});

export default router;
