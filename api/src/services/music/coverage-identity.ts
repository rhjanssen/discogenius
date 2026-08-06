/**
 * When two MusicBrainz Recordings satisfy the same library-coverage requirement.
 *
 * The default is the conservative one: **one Recording is one coverage unit**.
 * Two Recording MBIDs share a unit only when evidence shows they are duplicate
 * catalogue representations of the *same actual performance*. Getting this
 * wrong is not symmetric — a missed merge costs a duplicate download, a false
 * merge silently deletes a wanted performance from the discography — so every
 * rule here fails closed.
 *
 * What this is not:
 *
 *  - It is not provider matching. A provider Track accepted against several
 *    incompatible Recordings is an ambiguity in the match data, not proof that
 *    those Recordings are one performance. Provider evidence may corroborate a
 *    conclusion reached from catalogue evidence; it may never create one.
 *  - It is not unrestricted transitive closure. A≈B and B≈C only merge A and C
 *    when A and C are themselves compatible, so one bad edge cannot weld a
 *    component together. Edges are admitted strongest-first, and an edge that
 *    would make its component internally inconsistent is rejected and recorded
 *    rather than silently applied.
 *
 * The qualifier vocabulary below is an *incompatibility guard*, not positive
 * proof of identity: "(live)" tells us two Recordings are different, never that
 * two Recordings are the same.
 */

/** Recording facts this resolver reasons over. All optional beyond identity. */
export interface CoverageRecording {
  recordingId: number;
  title: string;
  lengthMs: number | null;
  /** Normalized on the way in; may come from the catalogue or provider evidence. */
  isrcs?: readonly string[];
  /** MusicBrainz disambiguation — carries version markers titles sometimes omit. */
  disambiguation?: string | null;
  /**
   * Recording ids this row is *known* to be the same catalogue entity as —
   * MusicBrainz merges, or Servarr's `oldRecordingIds`. Exact identity, not a
   * similarity judgement.
   */
  aliasRecordingIds?: readonly number[];
}

/** Strongest first. Ordering is what makes admission deterministic. */
export type CoverageEvidenceKind = "recording_identity" | "isrc" | "title_duration";

const EVIDENCE_RANK: Record<CoverageEvidenceKind, number> = {
  recording_identity: 0,
  isrc: 1,
  title_duration: 2,
};

export type CoverageRejectionReason =
  | "title_mismatch"
  | "version_mismatch"
  | "duration_mismatch"
  | "component_conflict";

export interface CoverageRejection {
  left: number;
  right: number;
  kind: CoverageEvidenceKind;
  reason: CoverageRejectionReason;
}

export interface QuarantinedProviderLink {
  provider: string;
  providerTrackItemId: number;
  recordingIds: number[];
  /** The first incompatible pair found, so the report can name the conflict. */
  conflict: { left: number; right: number; reason: CoverageRejectionReason };
}

export interface CoverageUnitResolution {
  /** Recording id → stable unit id (the lowest recording id in its class). */
  unitByRecording: Map<number, number>;
  /** Edges refused, with why — this is the explanation surface. */
  rejections: CoverageRejection[];
  /** Provider Track items whose accepted matches disagree with each other. */
  quarantinedProviderLinks: QuarantinedProviderLink[];
}

/**
 * Qualifiers that change the performance. Two Recordings that disagree on any
 * of these are different performances regardless of what else matches.
 */
const PERFORMANCE_QUALIFIERS = [
  "live", "acoustic", "unplugged", "remix", "rmx", "radio edit", "radio version",
  "extended", "instrumental", "demo", "alternate take", "alternate version",
  "alternative version", "re recorded", "rerecorded", "re recording", "taylors version",
  "session", "sessions", "reprise", "a cappella", "acapella", "karaoke", "dub",
  "edit", "mix", "orchestral", "symphonic", "piano version", "single version",
  "workout mix", "commentary", "interlude", "intro", "outro", "cover",
  // Corpus-frequency additions (MusicBrainz recording comments): a video of a
  // song is not the song, and a re-recording is a new performance entirely.
  "music video", "official music video", "video", "pv", "full length",
] as const;

/**
 * Channel/mix formats: the same performance rendered for different speakers.
 *
 * A Dolby Atmos mix of a song is that song, so the Library wants it once — the
 * Stereo and Spatial libraries are two places to put one wanted song, not two
 * songs. Acquisition still keeps them apart, because sourcing is anchored on
 * exact Recording identity and a spatial-labelled Edition will not accept a
 * stereo plan (see rendition-policy.ts).
 *
 * Normalised spellings, so "5.1 mix" appears here as "5 1 mix". Frequencies are
 * from the full MusicBrainz corpus.
 */
const MIX_FORMAT_QUALIFIERS = [
  "dolby atmos mix", "dolby atmos", "atmos mix", "atmos",   // 11806 / 395 / 9
  "360 reality audio mix", "360 reality audio",             // 1411
  "5 1 mix", "5 1 surround mix", "5 1 surround sound", "5 1 audio", // 2737 / 229
  "7 1 mix", "quadraphonic mix", "quadraphonic",            // 193 / 361
  "surround mix", "surround sound", "surround",
  "binaural", "ambisonic", "auro 3d",
] as const;

/**
 * Qualifiers that describe packaging or mastering rather than the performance.
 * Two Recordings may still be one performance across these — clean/explicit
 * twins are the case this exists for.
 */
const NEUTRAL_QUALIFIERS = new Set([
  "remaster", "remastered", "remasterd", "mono", "stereo", "explicit", "clean",
  "album version", "original", "original version", "original mix", "bonus track",
  "deluxe", "digital", "single", "edit version",
  ...MIX_FORMAT_QUALIFIERS,
]);

/** `Title (live at X) [remix]` → base `title`, qualifiers `live`, `remix`. */
export interface RecordingVersion {
  baseTitle: string;
  qualifiers: Set<string>;
}

/**
 * Catalogues mask profanity inconsistently — "Fuck Me Pumps", "F--- Me Pumps"
 * and "F*** Me Pumps" are one song written three ways. Masking runs are kept as
 * a `#` per hidden character so a masked token can still be matched against its
 * unmasked spelling by length and visible letters, instead of collapsing to a
 * bare "f" that looks like a different word.
 */
function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\p{Quotation_Mark}\p{Sk}'`]/gu, "")
    .replace(/&/g, " and ")
    // Masking, not ordinary punctuation. `*` and `_` never occur inside a real
    // word, so one is enough; a hyphen does, so it only counts as masking in a
    // run. Treating a single hyphen as a mask turned "re-recording" into
    // "re#recording" and stopped it being recognised as a distinct performance
    // — and would have done the same to every hyphenated title.
    .replace(/([a-z0-9])([*_]+|-{2,})(?=[a-z0-9\s]|$)/g, (_m, head: string, mask: string) =>
      `${head}${"#".repeat(mask.length)}`)
    .replace(/[^a-z0-9#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A masked token matches its unmasked spelling: same length, visible letters agree. */
function tokensMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  let sawMask = false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === "#" || b === "#") { sawMask = true; continue; }
    return false;
  }
  return sawMask;
}

/** Two normalized titles naming the same work, tolerating masked profanity. */
export function titlesMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const leftTokens = left.split(" ");
  const rightTokens = right.split(" ");
  if (leftTokens.length !== rightTokens.length) return false;
  return leftTokens.every((token, index) => tokensMatch(token, rightTokens[index]));
}

/**
 * Candidate-pairing key: the shape of the title, not its letters.
 *
 * Masking preserves length by construction, so "fuck me pumps" and
 * "f### me pumps" share the shape `3:4,2,5` and meet as candidates. Keying on
 * the letters would put them in different buckets and they would never be
 * compared. The bucket only proposes pairs — `factsCompatible` still decides,
 * so a same-shape but unrelated title is rejected there.
 */
function titleBucketKey(title: string): string {
  const tokens = title.split(" ");
  return `${tokens.length}:${tokens.map((token) => token.length).join(",")}`;
}

/** Qualifier tokens present in one already-normalized fragment. */
function qualifiersIn(fragment: string): string[] {
  const found: string[] = [];
  // Channel formats are consumed first and longest-first, so "dolby atmos mix"
  // wins over the bare "mix" inside it — a format difference must not read as a
  // remix. Each match is then *removed* from the fragment rather than returned,
  // because a comment carries independent attributes and the format is only one
  // of them: "live, 5.1 mix" is a live performance in surround, and returning
  // early on the format loses the `live` that makes it a different performance.
  // 1,261 corpus recordings carry both.
  let rest = fragment;
  for (const qualifier of MIX_FORMAT_QUALIFIERS) {
    const pattern = new RegExp(`(^| )${qualifier}( |$)`, "g");
    if (!pattern.test(rest)) continue;
    found.push(qualifier);
    rest = rest.replace(new RegExp(`(^| )${qualifier}( |$)`, "g"), " ").trim();
  }
  for (const qualifier of PERFORMANCE_QUALIFIERS) {
    // Word-boundary match so "edit" does not fire inside "editorial".
    const pattern = new RegExp(`(^| )${qualifier.replace(/ /g, " ")}( |$)`);
    if (pattern.test(rest)) found.push(qualifier);
  }
  for (const qualifier of NEUTRAL_QUALIFIERS) {
    const pattern = new RegExp(`(^| )${qualifier.replace(/ /g, " ")}( |$)`);
    if (pattern.test(rest)) found.push(qualifier);
  }
  return found;
}

/**
 * Split a Recording title (plus disambiguation) into the work and the version
 * markers attached to it.
 *
 * Only bracketed segments and a trailing ` - marker` are treated as version
 * markers; a song genuinely called "Live and Let Die" keeps its title intact.
 */
export function classifyRecordingVersion(
  title: string,
  disambiguation?: string | null,
): RecordingVersion {
  const raw = String(title || "");
  const segments: string[] = [];
  const withoutBrackets = raw.replace(/[([{][^)\]}]*[)\]}]/g, (match) => {
    segments.push(match.slice(1, -1));
    return " ";
  });

  // `Song - Live at Wembley` / `Song – 2011 Remaster`
  const dashSplit = withoutBrackets.split(/\s[-–—]\s/);
  let base = dashSplit[0];
  if (dashSplit.length > 1) segments.push(...dashSplit.slice(1));

  if (disambiguation) segments.push(String(disambiguation));

  const qualifiers = new Set<string>();
  for (const segment of segments) {
    for (const qualifier of qualifiersIn(normalizeText(segment))) {
      qualifiers.add(qualifier);
    }
  }
  // A marker written without brackets ("Pompeii live from Studio Brussel")
  // still counts; the base keeps the words so titles stay distinguishable.
  base = normalizeText(base);
  for (const qualifier of qualifiersIn(base)) qualifiers.add(qualifier);

  return { baseTitle: base, qualifiers };
}

/** Performance-affecting qualifiers only — the set that must agree. */
function performanceQualifiers(version: RecordingVersion): Set<string> {
  const result = new Set<string>();
  for (const qualifier of version.qualifiers) {
    if (!NEUTRAL_QUALIFIERS.has(qualifier)) result.add(qualifier);
  }
  return result;
}

/** ≤2s or ≤2% apart counts as the same performance length. */
export function durationsCompatible(
  leftMs: number | null | undefined,
  rightMs: number | null | undefined,
): boolean {
  if (leftMs == null || rightMs == null) return true; // unknown is not a conflict
  const left = Math.round(Number(leftMs));
  const right = Math.round(Number(rightMs));
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return true;
  const diff = Math.abs(left - right);
  return diff <= 2000 || diff / Math.max(left, right) <= 0.02;
}

export function normalizeIsrc(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type CompatibilityVerdict =
  | { compatible: true }
  | { compatible: false; reason: CoverageRejectionReason };

/**
 * Version facts derived once per Recording. Classification is regex-heavy and
 * the resolver compares the same recordings many times.
 */
interface RecordingFacts {
  recording: CoverageRecording;
  baseTitle: string;
  /** Performance-affecting qualifiers, sorted and joined for O(1) comparison. */
  versionKey: string;
}

function recordingFacts(recording: CoverageRecording): RecordingFacts {
  const version = classifyRecordingVersion(recording.title, recording.disambiguation);
  return {
    recording,
    baseTitle: version.baseTitle,
    versionKey: [...performanceQualifiers(version)].sort().join(","),
  };
}

function factsCompatible(left: RecordingFacts, right: RecordingFacts): CompatibilityVerdict {
  if (!titlesMatch(left.baseTitle, right.baseTitle)) {
    return { compatible: false, reason: "title_mismatch" };
  }
  if (left.versionKey !== right.versionKey) {
    return { compatible: false, reason: "version_mismatch" };
  }
  if (!durationsCompatible(left.recording.lengthMs, right.recording.lengthMs)) {
    return { compatible: false, reason: "duration_mismatch" };
  }
  return { compatible: true };
}

/**
 * Could these two Recordings be the same performance?
 *
 * This is a veto, not a verdict: passing it does not merge anything, it only
 * means no evidence forbids a merge that some other rule proposes.
 */
export function recordingsCompatible(
  left: CoverageRecording,
  right: CoverageRecording,
): CompatibilityVerdict {
  return factsCompatible(recordingFacts(left), recordingFacts(right));
}

interface CandidateEdge {
  left: number;
  right: number;
  kind: CoverageEvidenceKind;
}

/** Provider Track item → the Recordings its accepted matches point at. */
export interface ProviderTrackLink {
  provider: string;
  providerTrackItemId: number;
  recordingIds: readonly number[];
}

/**
 * Resolve coverage units for exactly the Recordings handed in.
 *
 * Nothing outside `recordings` can influence the answer, which is what lets an
 * Album page ask about thirty Recordings without paying for a hundred thousand.
 */
export function resolveCoverageUnits(
  recordings: readonly CoverageRecording[],
  providerLinks: readonly ProviderTrackLink[] = [],
): CoverageUnitResolution {
  const byId = new Map<number, CoverageRecording>();
  for (const recording of recordings) {
    const id = Number(recording.recordingId);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, recording);
  }
  const factsById = new Map<number, RecordingFacts>();
  for (const [id, recording] of byId) factsById.set(id, recordingFacts(recording));

  const parent = new Map<number, number>();
  // Membership is tracked as components merge. Deriving it by scanning every
  // recording per edge made the resolver quadratic: on a 32k-recording scope
  // that was ~157s, against ~1s for the same answer here.
  const componentMembers = new Map<number, number[]>();
  for (const id of byId.keys()) {
    parent.set(id, id);
    componentMembers.set(id, [id]);
  }
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const edges: CandidateEdge[] = [];
  const addEdge = (left: number, right: number, kind: CoverageEvidenceKind) => {
    if (left === right || !byId.has(left) || !byId.has(right)) return;
    edges.push({ left: Math.min(left, right), right: Math.max(left, right), kind });
  };

  // Exact catalogue identity: MusicBrainz merges / Servarr old recording ids.
  for (const recording of byId.values()) {
    for (const alias of recording.aliasRecordingIds || []) {
      addEdge(recording.recordingId, Number(alias), "recording_identity");
    }
  }

  // Shared ISRC — very strong, still subject to the compatibility veto.
  const byIsrc = new Map<string, number[]>();
  for (const recording of byId.values()) {
    for (const raw of recording.isrcs || []) {
      const isrc = normalizeIsrc(raw);
      if (!isrc) continue;
      const list = byIsrc.get(isrc) || [];
      list.push(recording.recordingId);
      byIsrc.set(isrc, list);
    }
  }
  for (const list of byIsrc.values()) {
    const unique = [...new Set(list)].sort((a, b) => a - b);
    for (let i = 1; i < unique.length; i += 1) addEdge(unique[0], unique[i], "isrc");
  }

  // Title + duration — the weakest rule, and the reason duration is mandatory
  // here: title alone cannot tell a re-recording from its original.
  const byTitle = new Map<string, number[]>();
  // Masked titles are rare, so they get their own narrow fan-out rather than
  // making every candidate pair go through the looser shape key.
  const byShape = new Map<string, number[]>();
  const maskedIds: number[] = [];
  for (const recording of byId.values()) {
    if (recording.lengthMs == null || !Number.isFinite(Number(recording.lengthMs))) continue;
    const version = classifyRecordingVersion(recording.title, recording.disambiguation);
    if (!version.baseTitle) continue;
    const qualifierKey = [...performanceQualifiers(version)].sort().join(",");

    const exactKey = `${version.baseTitle} ${qualifierKey}`;
    byTitle.set(exactKey, [...(byTitle.get(exactKey) ?? []), recording.recordingId]);

    const shapeKey = `${titleBucketKey(version.baseTitle)} ${qualifierKey}`;
    byShape.set(shapeKey, [...(byShape.get(shapeKey) ?? []), recording.recordingId]);
    if (version.baseTitle.includes("#")) maskedIds.push(recording.recordingId);
  }
  for (const list of byTitle.values()) {
    const unique = [...new Set(list)].sort((a, b) => a - b);
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        addEdge(unique[i], unique[j], "title_duration");
      }
    }
  }
  // A masked spelling reaches its unmasked twin only through the shape bucket.
  for (const maskedId of maskedIds) {
    const recording = byId.get(maskedId)!;
    const version = classifyRecordingVersion(recording.title, recording.disambiguation);
    const shapeKey = `${titleBucketKey(version.baseTitle)} ${[...performanceQualifiers(version)].sort().join(",")}`;
    for (const candidateId of byShape.get(shapeKey) ?? []) {
      addEdge(maskedId, candidateId, "title_duration");
    }
  }

  // Provider agreement is corroboration, never a source of equivalence — but a
  // provider Track whose accepted matches disagree with each other is a defect
  // worth naming, so it is quarantined and reported instead of being ignored.
  const quarantinedProviderLinks: QuarantinedProviderLink[] = [];
  for (const link of providerLinks) {
    const ids = [...new Set(link.recordingIds.map(Number).filter((id) => byId.has(id)))]
      .sort((a, b) => a - b);
    if (ids.length < 2) continue;
    let conflict: QuarantinedProviderLink["conflict"] | null = null;
    outer: for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const verdict = factsCompatible(factsById.get(ids[i])!, factsById.get(ids[j])!);
        if (!verdict.compatible) {
          conflict = { left: ids[i], right: ids[j], reason: verdict.reason };
          break outer;
        }
      }
    }
    if (conflict) {
      quarantinedProviderLinks.push({
        provider: link.provider,
        providerTrackItemId: link.providerTrackItemId,
        recordingIds: ids,
        conflict,
      });
    }
  }

  // Admit strongest evidence first, and only while the resulting component stays
  // internally consistent: every member of one side must be compatible with
  // every member of the other. That is what stops A≈B, B≈C from implying A≈C.
  edges.sort((a, b) =>
    EVIDENCE_RANK[a.kind] - EVIDENCE_RANK[b.kind]
    || a.left - b.left
    || a.right - b.right);

  const rejections: CoverageRejection[] = [];
  for (const edge of edges) {
    const leftRoot = find(edge.left);
    const rightRoot = find(edge.right);
    if (leftRoot === rightRoot) continue;

    const leftMembers = componentMembers.get(leftRoot)!;
    const rightMembers = componentMembers.get(rightRoot)!;

    if (edge.kind !== "recording_identity") {
      let blocked: CoverageRejectionReason | null = null;
      outer: for (const a of leftMembers) {
        for (const b of rightMembers) {
          const verdict = factsCompatible(factsById.get(a)!, factsById.get(b)!);
          if (!verdict.compatible) {
            blocked = a === edge.left && b === edge.right ? verdict.reason : "component_conflict";
            break outer;
          }
        }
      }
      if (blocked) {
        rejections.push({ left: edge.left, right: edge.right, kind: edge.kind, reason: blocked });
        continue;
      }
    }

    // Lowest id roots the class so unit ids stay stable across runs.
    const [keep, absorb] = leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    parent.set(absorb, keep);
    componentMembers.set(keep, [...componentMembers.get(keep)!, ...componentMembers.get(absorb)!]);
    componentMembers.delete(absorb);
  }

  const unitByRecording = new Map<number, number>();
  for (const id of byId.keys()) unitByRecording.set(id, find(id));
  return { unitByRecording, rejections, quarantinedProviderLinks };
}
