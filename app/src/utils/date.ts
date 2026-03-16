export function formatDdMonthYyyy(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;
  const date = (() => {
    if (value instanceof Date) return value;
    if (typeof value === "number") return new Date(value);
    const raw = String(value).trim();
    // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS" (UTC)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
      return new Date(`${raw.replace(" ", "T")}Z`);
    }
    return new Date(raw);
  })();
  if (Number.isNaN(date.getTime())) return null;

  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "long" });
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

export function formatMetadataAttribution(
  source: string | null | undefined,
  lastUpdated: string | number | Date | null | undefined
): string | null {
  const parts: string[] = [];
  if (source) parts.push(source);

  const formattedDate = formatDdMonthYyyy(lastUpdated);
  if (formattedDate) parts.push(formattedDate);

  if (parts.length === 0) return null;
  return parts.join(" · ");
}
