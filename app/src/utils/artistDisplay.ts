export function formatArtistLastScanned(date: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  const elapsed = Date.now() - parsed.getTime();
  const days = Math.floor(elapsed / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return parsed.toLocaleDateString();
}
