export function renderableArtworkUrl(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  if (/^(https?:\/\/|\/|data:|blob:)/i.test(text)) {
    return text;
  }

  return null;
}
