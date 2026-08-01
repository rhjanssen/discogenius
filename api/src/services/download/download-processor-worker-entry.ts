import { parentPort, workerData } from 'node:worker_threads';

import { DownloadProcessor, DOWNLOAD_WORKER_MARKER, downloadProcessor } from './download-processor.js';
import { downloadEvents } from './download-events.js';

type DownloadProcessorStatus = ReturnType<DownloadProcessor['getStatus']>;

type WorkerRequest =
    | { kind: 'initialize'; requestId: number }
    | { kind: 'processQueue'; requestId: number }
    | { kind: 'pause'; requestId: number }
    | { kind: 'suspend'; requestId: number }
    | { kind: 'resume'; requestId: number }
    | { kind: 'cancelJob'; requestId: number; commandId: number };

type WorkerResponse =
    | { kind: 'ready' }
    | { kind: 'status'; status: DownloadProcessorStatus }
    | { kind: 'downloadEvent'; event: string; payload: unknown }
    | { kind: 'response'; requestId: number; ok: true }
    | { kind: 'response'; requestId: number; ok: false; error: string };

if (!parentPort || (workerData as Record<string, unknown> | null)?.[DOWNLOAD_WORKER_MARKER] !== true) {
    throw new Error('download-processor-worker-entry loaded outside a Discogenius download worker thread');
}

const port = parentPort;
// Reuse the module singleton (a real DownloadProcessor in this thread) so any
// in-worker consumer of `downloadProcessor` observes the same instance.
const processor = downloadProcessor as DownloadProcessor;
let initializationStarted = false;

function post(message: WorkerResponse): void {
    port.postMessage(message);
}

function postStatus(): void {
    post({ kind: 'status', status: processor.getStatus() });
}

function postDownloadEvent(event: string, payload: unknown): void {
    post({ kind: 'downloadEvent', event, payload });
    postStatus();
}

downloadEvents.on('progress-batch', (payload) => postDownloadEvent('progress-batch', payload));
downloadEvents.on('started', (payload) => postDownloadEvent('started', payload));
downloadEvents.on('completed', (payload) => postDownloadEvent('completed', payload));
downloadEvents.on('failed', (payload) => postDownloadEvent('failed', payload));
downloadEvents.on('queue-status', (payload) => postDownloadEvent('queue-status', payload));

// Status must go out BEFORE the response ack: port messages are delivered in
// order, so this guarantees the proxy has applied the fresh snapshot by the
// time the awaiting caller's promise resolves.
function acknowledge(requestId: number): void {
    postStatus();
    post({ kind: 'response', requestId, ok: true });
}

function reject(requestId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    postStatus();
    post({ kind: 'response', requestId, ok: false, error: message });
}

function runDetached(operation: () => Promise<void>): void {
    void operation().catch((error) => {
        console.error('[DOWNLOAD-PROCESSOR] Worker operation failed:', error);
        postStatus();
    });
}

port.on('message', (message: WorkerRequest) => {
    switch (message.kind) {
        case 'initialize':
            if (!initializationStarted) {
                initializationStarted = true;
                runDetached(() => processor.initialize());
            }
            acknowledge(message.requestId);
            break;
        case 'processQueue':
            runDetached(() => processor.processQueue());
            acknowledge(message.requestId);
            break;
        case 'pause':
            void processor.pause()
                .then(() => acknowledge(message.requestId))
                .catch((error) => reject(message.requestId, error));
            break;
        case 'suspend':
            void processor.suspend()
                .then(() => acknowledge(message.requestId))
                .catch((error) => reject(message.requestId, error));
            break;
        case 'resume':
            void processor.resume()
                .then(() => acknowledge(message.requestId))
                .catch((error) => reject(message.requestId, error));
            break;
        case 'cancelJob':
            void processor.cancelJob(message.commandId)
                .then(() => acknowledge(message.requestId))
                .catch((error) => reject(message.requestId, error));
            break;
    }
});

post({ kind: 'ready' });
postStatus();
