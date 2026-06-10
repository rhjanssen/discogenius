import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { streamSegmentedPlayback } from "./playback-segment-worker.js";

function createResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": "audio/mp4",
    },
  });
}

test("streamSegmentedPlayback writes segments in order", async () => {
  const previousFetch = global.fetch;
  const requestedUrls: string[] = [];
  const output = new PassThrough();
  const received: Buffer[] = [];

  output.on("data", (chunk) => received.push(Buffer.from(chunk)));

  try {
    global.fetch = (async (url: string) => {
      requestedUrls.push(url);
      if (url.endsWith("segment-1")) {
        return createResponse(["one-", "two"]);
      }

      if (url.endsWith("segment-2")) {
        return createResponse(["three"]);
      }

      return createResponse([], 404);
    }) as typeof fetch;

    await streamSegmentedPlayback(
      {
        segments: ["https://cdn.example/segment-1", "https://cdn.example/segment-2"],
        contentType: "audio/mp4",
      },
      output,
    );

    output.end();

    assert.deepEqual(requestedUrls, [
      "https://cdn.example/segment-1",
      "https://cdn.example/segment-2",
    ]);
    assert.equal(Buffer.concat(received).toString("utf8"), "one-twothree");
  } finally {
    output.destroy();
    global.fetch = previousFetch;
  }
});

test("streamSegmentedPlayback stops when a segment fails", async () => {
  const previousFetch = global.fetch;
  const output = new PassThrough();

  try {
    global.fetch = (async (url: string) => {
      if (url.endsWith("segment-1")) {
        return createResponse(["ok"]);
      }

      return createResponse([], 502);
    }) as typeof fetch;

    await assert.rejects(
      streamSegmentedPlayback(
        {
          segments: ["https://cdn.example/segment-1", "https://cdn.example/segment-2"],
          contentType: "audio/mp4",
        },
        output,
      ),
      /Segment 2 of 2 failed/,
    );
  } finally {
    output.destroy();
    global.fetch = previousFetch;
  }
});
