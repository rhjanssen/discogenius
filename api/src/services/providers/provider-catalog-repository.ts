import type Database from "better-sqlite3";
import type { NormalizedAudioQuality } from "../music/acquisition-plan-optimizer.js";
import {
  expectedFactsForProviderTier,
  type ProviderSessionCapabilities,
} from "./audio-facts.js";

export type ProviderEntityType = "artist" | "release" | "track" | "video";

export interface ProviderItemFacts {
  provider: string;
  entityType: ProviderEntityType;
  providerId: string;
  title?: string | null;
  version?: string | null;
  providerType?: string | null;
  upc?: string | null;
  isrc?: string | null;
  durationMs?: number | null;
  releaseDate?: string | null;
  explicit?: boolean | null;
  availability?: string | null;
  availabilityReason?: string | null;
  checkedAt?: string | null;
  providerUrl?: string | null;
  coverId?: string | null;
  artworkUrl?: string | null;
  volumeCount?: number | null;
  replayGain?: number | null;
  peak?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  popularity?: number | null;
  videoQuality?: string | null;
  copyright?: string | null;
}

export interface ProviderReleaseMemberInput {
  memberItemId: number;
  mediumPosition: number;
  position: number;
  number?: string | null;
  contextualTitle?: string | null;
  contextualDurationMs?: number | null;
}

export interface ProviderCreditInput {
  artistItemId: number;
  ordinal: number;
  creditedName: string;
  joinPhrase?: string;
  normalizedRole?: "primary" | "featured" | "remixer" | "other";
  providerRole?: string | null;
}

export interface ProviderAudioVariantInput {
  variantKey: string;
  qualityClass: NormalizedAudioQuality;
  codec?: string | null;
  container?: string | null;
  lossless?: boolean | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  channelCount?: number | null;
  channelLayout?: string | null;
  spatialFormat?: string | null;
  providerQualityLabel?: string | null;
  availability?: string | null;
  availabilityReason?: string | null;
  verifiedAt?: string | null;
}

function text(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export class ProviderCatalogRepository {
  constructor(private readonly db: Database.Database) {}

  upsertItem(facts: ProviderItemFacts): number {
    const provider = text(facts.provider);
    const providerId = text(facts.providerId);
    if (!provider || !providerId) {
      throw new Error("Provider item requires provider and providerId");
    }
    const row = this.db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, title, version, provider_type, upc, isrc,
        duration_ms, release_date, explicit, availability, availability_reason,
        checked_at, provider_url, cover_id, artwork_url, volume_count, replay_gain,
        peak, bpm, musical_key, popularity, video_quality, copyright, updated_at
      ) VALUES (
        @provider, @entityType, @providerId, @title, @version, @providerType, @upc, @isrc,
        @durationMs, @releaseDate, @explicit, @availability, @availabilityReason,
        @checkedAt, @providerUrl, @coverId, @artworkUrl, @volumeCount, @replayGain,
        @peak, @bpm, @musicalKey, @popularity, @videoQuality, @copyright, CURRENT_TIMESTAMP
      )
      ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
        title = COALESCE(excluded.title, ProviderItems.title),
        version = COALESCE(excluded.version, ProviderItems.version),
        provider_type = COALESCE(excluded.provider_type, ProviderItems.provider_type),
        upc = COALESCE(excluded.upc, ProviderItems.upc),
        isrc = COALESCE(excluded.isrc, ProviderItems.isrc),
        duration_ms = COALESCE(excluded.duration_ms, ProviderItems.duration_ms),
        release_date = COALESCE(excluded.release_date, ProviderItems.release_date),
        explicit = COALESCE(excluded.explicit, ProviderItems.explicit),
        availability = excluded.availability,
        availability_reason = excluded.availability_reason,
        checked_at = excluded.checked_at,
        provider_url = COALESCE(excluded.provider_url, ProviderItems.provider_url),
        cover_id = COALESCE(excluded.cover_id, ProviderItems.cover_id),
        artwork_url = COALESCE(excluded.artwork_url, ProviderItems.artwork_url),
        volume_count = COALESCE(excluded.volume_count, ProviderItems.volume_count),
        replay_gain = COALESCE(excluded.replay_gain, ProviderItems.replay_gain),
        peak = COALESCE(excluded.peak, ProviderItems.peak),
        bpm = COALESCE(excluded.bpm, ProviderItems.bpm),
        musical_key = COALESCE(excluded.musical_key, ProviderItems.musical_key),
        popularity = COALESCE(excluded.popularity, ProviderItems.popularity),
        video_quality = COALESCE(excluded.video_quality, ProviderItems.video_quality),
        copyright = COALESCE(excluded.copyright, ProviderItems.copyright),
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get({
      provider,
      entityType: facts.entityType,
      providerId,
      title: text(facts.title),
      version: text(facts.version),
      providerType: text(facts.providerType),
      upc: text(facts.upc),
      isrc: text(facts.isrc),
      durationMs: facts.durationMs ?? null,
      releaseDate: text(facts.releaseDate),
      explicit: facts.explicit == null ? null : Number(facts.explicit),
      availability: text(facts.availability) || "unknown",
      availabilityReason: text(facts.availabilityReason),
      checkedAt: text(facts.checkedAt),
      providerUrl: text(facts.providerUrl),
      coverId: text(facts.coverId),
      artworkUrl: text(facts.artworkUrl),
      volumeCount: facts.volumeCount ?? null,
      replayGain: facts.replayGain ?? null,
      peak: facts.peak ?? null,
      bpm: facts.bpm ?? null,
      musicalKey: text(facts.musicalKey),
      popularity: facts.popularity ?? null,
      videoQuality: text(facts.videoQuality),
      copyright: text(facts.copyright),
    }) as { id: number };
    return row.id;
  }

  replaceReleaseMembers(
    providerEditionItemId: number,
    members: readonly ProviderReleaseMemberInput[],
  ): number[] {
    const seenPositions = new Set<string>();
    for (const member of members) {
      const key = `${member.mediumPosition}:${member.position}`;
      if (seenPositions.has(key)) throw new Error(`Duplicate provider release position ${key}`);
      seenPositions.add(key);
    }
    const insert = this.db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position,
        number, contextual_title, contextual_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, member_item_id, medium_position, position
        FROM ProviderEditionMembers
        WHERE provider_edition_item_id = ?
      `).all(providerEditionItemId) as Array<{
        id: number;
        member_item_id: number;
        medium_position: number;
        position: number;
      }>;
      const existingByPosition = new Map<string, (typeof existing)[number]>(
        existing.map((row) => [`${row.medium_position}:${row.position}`, row] as const),
      );
      const retainedIds = new Set<number>();
      const update = this.db.prepare(`
        UPDATE ProviderEditionMembers
        SET number = ?,
            contextual_title = ?,
            contextual_duration_ms = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const remove = this.db.prepare("DELETE FROM ProviderEditionMembers WHERE id = ?");
      const ids = members.map((member) => {
        const key = `${member.mediumPosition}:${member.position}`;
        const current = existingByPosition.get(key);
        if (current && current.member_item_id === member.memberItemId) {
          update.run(
            text(member.number),
            text(member.contextualTitle),
            member.contextualDurationMs ?? null,
            current.id,
          );
          retainedIds.add(current.id);
          return current.id;
        }
        if (current) remove.run(current.id);
        const id = (insert.get(
          providerEditionItemId,
          member.memberItemId,
          member.mediumPosition,
          member.position,
          text(member.number),
          text(member.contextualTitle),
          member.contextualDurationMs ?? null,
        ) as { id: number }).id;
        retainedIds.add(id);
        return id;
      });
      for (const row of existing) {
        if (!retainedIds.has(row.id)) remove.run(row.id);
      }
      return ids;
    })();
  }

  replaceCredits(itemId: number, credits: readonly ProviderCreditInput[]): void {
    const insert = this.db.prepare(`
      INSERT INTO ProviderItemCredits (
        item_id, artist_item_id, ordinal, credited_name, join_phrase,
        normalized_role, provider_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ProviderItemCredits WHERE item_id = ?").run(itemId);
      for (const credit of [...credits].sort((left, right) => left.ordinal - right.ordinal)) {
        insert.run(
          itemId,
          credit.artistItemId,
          credit.ordinal,
          credit.creditedName,
          credit.joinPhrase || "",
          credit.normalizedRole || "other",
          text(credit.providerRole),
        );
      }
    })();
  }

  /**
   * Persist a provider item's audio variants, filling in the technical
   * properties its tier is expected to deliver.
   *
   * A provider hands us a tier and nothing finer, so a variant row would
   * otherwise carry only `quality_class` — and ranking two lossy offers on
   * that is impossible. Filling each row from
   * `expectedFactsForProviderTier` gives the planner a codec and a bitrate to
   * compare, without a per-track request anywhere.
   *
   * Anything the provider actually told us wins over the expectation: a real
   * value is always better evidence than a representative one.
   */
  replaceAudioVariants(
    providerItemId: number,
    variants: readonly ProviderAudioVariantInput[],
    /** Provider id and session capabilities, so the expectation can be looked up. */
    context?: { provider?: string | null; capabilities?: ProviderSessionCapabilities },
  ): number[] {
    const insert = this.db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, codec, container, lossless,
        bit_depth, sample_rate, bitrate, channel_count, channel_layout,
        spatial_format, provider_quality_label, availability,
        availability_reason, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM ProviderItemAudioVariants WHERE provider_item_id = ?")
        .run(providerItemId);
      return variants.map((variant) => {
        const expectedFacts = expectedFactsForProviderTier(
          context?.provider, variant.variantKey, context?.capabilities ?? {},
        );
        return (insert.get(
        providerItemId,
        variant.variantKey,
        variant.qualityClass,
        text(variant.codec) || expectedFacts?.codec || null,
        text(variant.container) || expectedFacts?.container || null,
        variant.lossless == null
          ? (expectedFacts?.lossless == null ? null : Number(expectedFacts.lossless))
          : Number(variant.lossless),
        variant.bitDepth ?? expectedFacts?.bitDepth ?? null,
        variant.sampleRate ?? expectedFacts?.sampleRateHz ?? null,
        variant.bitrate ?? expectedFacts?.bitrateKbps ?? null,
        variant.channelCount ?? expectedFacts?.channelCount ?? null,
        text(variant.channelLayout) || expectedFacts?.channelLayout || null,
        text(variant.spatialFormat) || expectedFacts?.immersiveFormat || null,
        text(variant.providerQualityLabel),
        text(variant.availability) || "unknown",
        text(variant.availabilityReason),
        text(variant.verifiedAt),
        ) as { id: number }).id;
      });
    })();
  }
}
