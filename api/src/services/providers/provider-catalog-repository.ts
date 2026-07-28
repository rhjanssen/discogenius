import type Database from "better-sqlite3";
import type { NormalizedAudioQuality } from "../music/acquisition-plan-optimizer.js";

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
        peak, bpm, musical_key, copyright, updated_at
      ) VALUES (
        @provider, @entityType, @providerId, @title, @version, @providerType, @upc, @isrc,
        @durationMs, @releaseDate, @explicit, @availability, @availabilityReason,
        @checkedAt, @providerUrl, @coverId, @artworkUrl, @volumeCount, @replayGain,
        @peak, @bpm, @musicalKey, @copyright, CURRENT_TIMESTAMP
      )
      ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
        title = excluded.title,
        version = excluded.version,
        provider_type = excluded.provider_type,
        upc = excluded.upc,
        isrc = excluded.isrc,
        duration_ms = excluded.duration_ms,
        release_date = excluded.release_date,
        explicit = excluded.explicit,
        availability = excluded.availability,
        availability_reason = excluded.availability_reason,
        checked_at = excluded.checked_at,
        provider_url = excluded.provider_url,
        cover_id = excluded.cover_id,
        artwork_url = excluded.artwork_url,
        volume_count = excluded.volume_count,
        replay_gain = excluded.replay_gain,
        peak = excluded.peak,
        bpm = excluded.bpm,
        musical_key = excluded.musical_key,
        copyright = excluded.copyright,
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
      copyright: text(facts.copyright),
    }) as { id: number };
    return row.id;
  }

  replaceReleaseMembers(
    providerReleaseItemId: number,
    members: readonly ProviderReleaseMemberInput[],
  ): number[] {
    const seenPositions = new Set<string>();
    for (const member of members) {
      const key = `${member.mediumPosition}:${member.position}`;
      if (seenPositions.has(key)) throw new Error(`Duplicate provider release position ${key}`);
      seenPositions.add(key);
    }
    const insert = this.db.prepare(`
      INSERT INTO ProviderReleaseMembers (
        provider_release_item_id, member_item_id, medium_position, position,
        number, contextual_title, contextual_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM ProviderReleaseMembers WHERE provider_release_item_id = ?")
        .run(providerReleaseItemId);
      return members.map((member) => (insert.get(
        providerReleaseItemId,
        member.memberItemId,
        member.mediumPosition,
        member.position,
        text(member.number),
        text(member.contextualTitle),
        member.contextualDurationMs ?? null,
      ) as { id: number }).id);
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

  replaceAudioVariants(
    providerItemId: number,
    variants: readonly ProviderAudioVariantInput[],
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
      return variants.map((variant) => (insert.get(
        providerItemId,
        variant.variantKey,
        variant.qualityClass,
        text(variant.codec),
        text(variant.container),
        variant.lossless == null ? null : Number(variant.lossless),
        variant.bitDepth ?? null,
        variant.sampleRate ?? null,
        variant.bitrate ?? null,
        variant.channelCount ?? null,
        text(variant.channelLayout),
        text(variant.spatialFormat),
        text(variant.providerQualityLabel),
        text(variant.availability) || "unknown",
        text(variant.availabilityReason),
        text(variant.verifiedAt),
      ) as { id: number }).id);
    })();
  }
}
