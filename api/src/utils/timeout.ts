function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error ?? "");
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  const text = errorText(error).toLowerCase();
  return text.includes("timeout") || text.includes("timed out") || /\betimedout\b/.test(text);
}
