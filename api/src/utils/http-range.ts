export interface ParsedByteRange {
  start: number;
  end: number;
  chunkSize: number;
}

export type ByteRangeParseResult =
  | { satisfiable: true; range: ParsedByteRange | null }
  | { satisfiable: false; contentRange: string };

export function parseSingleByteRange(rangeHeader: string | undefined, fileSize: number): ByteRangeParseResult {
  if (!rangeHeader) {
    return { satisfiable: true, range: null };
  }

  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    return { satisfiable: false, contentRange: "bytes */*" };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { satisfiable: false, contentRange: `bytes */${fileSize}` };
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { satisfiable: false, contentRange: `bytes */${fileSize}` };
  }

  if (fileSize === 0) {
    return { satisfiable: false, contentRange: "bytes */0" };
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { satisfiable: false, contentRange: `bytes */${fileSize}` };
    }

    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { satisfiable: false, contentRange: `bytes */${fileSize}` };
    }
  }

  if (start < 0 || end < start || start >= fileSize) {
    return { satisfiable: false, contentRange: `bytes */${fileSize}` };
  }

  end = Math.min(end, fileSize - 1);

  return {
    satisfiable: true,
    range: {
      start,
      end,
      chunkSize: end - start + 1,
    },
  };
}
