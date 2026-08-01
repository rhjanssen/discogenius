import { parentPort } from "node:worker_threads";

import { CommandQueueManager } from "../command-queue-manager.js";
import {
    getCommandWorkerId,
    isCommandWorker,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from "./command-worker-protocol.js";

if (!parentPort || !isCommandWorker()) {
    throw new Error("command-worker-liveness fixture loaded outside a command worker");
}

const port = parentPort;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let completionTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (completionTimer) clearTimeout(completionTimer);
    heartbeatTimer = null;
    completionTimer = null;
}

function post(message: WorkerToMainMessage): void {
    port.postMessage(message);
}

function startHeartbeats(
    message: Extract<MainToWorkerMessage, { kind: "run" }>,
): void {
    const { job } = message;
    if (!job.worker_id) return;
    const leaseMs = Math.max(20, message.leaseMs ?? 100);
    const heartbeatMs = Math.max(5, message.heartbeatMs ?? 20);
    const beat = () => {
        const renewed = CommandQueueManager.renewLease(job.id, job.worker_id!, leaseMs);
        post({
            kind: "heartbeat",
            commandId: job.id,
            workerId: job.worker_id!,
            physicalWorkerId: getCommandWorkerId(),
            renewed,
            sentAt: new Date().toISOString(),
        });
    };
    beat();
    heartbeatTimer = setInterval(beat, heartbeatMs);
}

port.on("message", (message: MainToWorkerMessage) => {
    if (message.kind === "shutdown") {
        clearTimers();
        port.close();
        return;
    }

    clearTimers();
    const behavior = String(
        (message.job.payload as Record<string, unknown>).testBehavior ?? "complete",
    );

    if (behavior === "crash") {
        process.exit(19);
    }
    if (behavior === "exit-zero") {
        process.exit(0);
    }
    if (behavior === "hang") {
        return;
    }

    startHeartbeats(message);
    if (behavior === "hang-heartbeat") {
        return;
    }

    const durationMs = Number(
        (message.job.payload as Record<string, unknown>).testDurationMs ?? 25,
    );
    completionTimer = setTimeout(() => {
        clearTimers();
        post({ kind: "done", commandId: message.job.id });
    }, Math.max(0, durationMs));
});

post({ kind: "ready", physicalWorkerId: getCommandWorkerId() });
