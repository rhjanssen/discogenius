import { describe, it, expect } from "vitest";
import { formatDdMonthYyyy, formatMetadataAttribution } from "./date.js";

describe("date utilities", () => {
  describe("formatDdMonthYyyy", () => {
    it("should return null for null, undefined, or empty string", () => {
      expect(formatDdMonthYyyy(null)).toBeNull();
      expect(formatDdMonthYyyy(undefined)).toBeNull();
      expect(formatDdMonthYyyy("")).toBeNull();
    });

    it("should return null for invalid date values", () => {
      expect(formatDdMonthYyyy("invalid-date-string")).toBeNull();
      expect(formatDdMonthYyyy(NaN)).toBeNull();
    });

    it("should format a Date object correctly", () => {
      const date = new Date(2026, 5, 2); // June 2, 2026 (Month is 0-indexed)
      expect(formatDdMonthYyyy(date)).toBe("02-June-2026");
    });

    it("should format an epoch timestamp number correctly", () => {
      const timestamp = new Date(2026, 5, 2).getTime();
      expect(formatDdMonthYyyy(timestamp)).toBe("02-June-2026");
    });

    it("should format a standard ISO string correctly", () => {
      expect(formatDdMonthYyyy("2026-06-02T13:00:00Z")).toBe("02-June-2026");
    });

    it("should parse and format a SQLite CURRENT_TIMESTAMP string format", () => {
      // SQLite CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" (UTC)
      expect(formatDdMonthYyyy("2026-06-02 13:00:00")).toBe("02-June-2026");
    });
  });

  describe("formatMetadataAttribution", () => {
    it("should return null if both source and date are missing or empty", () => {
      expect(formatMetadataAttribution(null, null)).toBeNull();
      expect(formatMetadataAttribution(undefined, undefined)).toBeNull();
      expect(formatMetadataAttribution("", "")).toBeNull();
    });

    it("should filter out internal metadata sources", () => {
      expect(formatMetadataAttribution("lidarr", null)).toBeNull();
      expect(formatMetadataAttribution("lidarr-metadata", null)).toBeNull();
      expect(formatMetadataAttribution("Servarr Metadata Server", null)).toBeNull();
      expect(formatMetadataAttribution("servarr-metadata", null)).toBeNull();
      expect(formatMetadataAttribution("LIDARR", null)).toBeNull();
    });

    it("should format attribution with only custom source", () => {
      expect(formatMetadataAttribution("TIDAL", null)).toBe("Source: TIDAL");
      expect(formatMetadataAttribution("Bandcamp", undefined)).toBe("Source: Bandcamp");
    });

    it("should format attribution with only update date", () => {
      const dateString = "2026-06-02T13:00:00Z";
      expect(formatMetadataAttribution(null, dateString)).toBe("Updated: 02-June-2026");
    });

    it("should format attribution with internal source and update date", () => {
      const dateString = "2026-06-02T13:00:00Z";
      expect(formatMetadataAttribution("Servarr Metadata Server", dateString)).toBe("Updated: 02-June-2026");
    });

    it("should format full attribution with custom source and update date", () => {
      const dateString = "2026-06-02T13:00:00Z";
      expect(formatMetadataAttribution("TIDAL", dateString)).toBe("Source: TIDAL · Updated: 02-June-2026");
    });
  });
});
