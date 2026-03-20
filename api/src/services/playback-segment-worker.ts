import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";

export interface SegmentedPlaybackJob {
  segments: string[];
  contentType: string;
}

export interface SegmentedPlaybackWorkerProcess extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

const WORKER_ARG_PREFIX = "--playback-job=";

function encodeJob(job: SegmentedPlaybackJob) {
  return Buffer.from(JSON.stringify(job), "utf8").toString("base64url");
}

function decodeJob(encoded: string): SegmentedPlaybackJob {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SegmentedPlaybackJob;

  if (!parsed || !Array.isArray(parsed.segments) || typeof parsed.contentType !== "string") {
    throw new Error("Invalid playback job payload");
  }

  return {
    segments: parsed.segments.filter((segment) => typeof segment === "string" && segment.length > 0),
    contentType: parsed.contentType,
  };
}

async function writeStreamToOutput(stream: ReadableStream<Uint8Array>, output: Writable) {
  const nodeStream = Readable.fromWeb(stream as any);

  for await (const chunk of nodeStream) {
    if (!output.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        output.once("drain", resolve);
        output.once("error", reject);
      });
    }
  }
}

export async function streamSegmentedPlayback(job: SegmentedPlaybackJob, output: Writable, signal?: AbortSignal) {
  for (let index = 0; index < job.segments.length; index++) {
    if (signal?.aborted) {
      const abortError = new Error("Playback worker aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const segmentUrl = job.segments[index];
    const response = await fetch(segmentUrl, { signal });

    if (!response.ok || !response.body) {
      throw new Error(`Segment ${index + 1} of ${job.segments.length} failed with status ${response.status}`);
    }

    await writeStreamToOutput(response.body, output);
  }
}

export function spawnSegmentedPlaybackWorker(job: SegmentedPlaybackJob): SegmentedPlaybackWorkerProcess {
  const workerPath = fileURLToPath(new URL("./playback-segment-worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath, `${WORKER_ARG_PREFIX}${encodeJob(job)}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  return child as SegmentedPlaybackWorkerProcess;
}

async function runAsWorker() {
  const arg = process.argv.slice(2).find((value) => value.startsWith(WORKER_ARG_PREFIX));
  if (!arg) {
    throw new Error("Missing playback worker payload");
  }

  const job = decodeJob(arg.slice(WORKER_ARG_PREFIX.length));
  const abortController = new AbortController();

  const handleSignal = () => abortController.abort();
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  try {
    await streamSegmentedPlayback(job, process.stdout, abortController.signal);
  } finally {
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPoint) {
  runAsWorker().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[PlaybackWorker] ${message}`);
    process.exitCode = 1;
  });
}
