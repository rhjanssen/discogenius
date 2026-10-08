# Managed library inventory and strict cleanup

## October 8 authoritative catalogue redirect evidence candidate

Lidarr receives OldIds and OldRecordingIds from SkyHook and treats these as
separate track and recording identity namespaces. Our local PostgreSQL mirror
adapter omitted both. Its bounded edition hydration now reads track_gid_redirect
and recording_gid_redirect through their indexed new_id columns, keeps ordered
alias arrays, and carries them through the existing MusicBrainz DTO mapper as
OldIds and OldRecordingIds. WS/2 reads do not invent aliases from names or slots.

Before any release-group catalogue writes, reconciliation validates the complete
incoming alias graph. Malformed arrays/entries, a source still present as a
current ID, and one source redirecting to conflicting targets are rejected. One
recording legitimately appearing on several editions may repeat the same agreed
recording redirect. Track and recording namespaces remain distinct. Edition
normalization applies the same validation for its own boundary.

Readonly inspection against the configured MusicBrainz mirror confirms both
redirect tables and indexes on new_id. None of the three failing obsolete track
IDs has a track redirect. Cliff Richard's recording
51495e16-4c34-4bcf-9b0e-eddec1d7e311 redirects to
3fff979b-60bb-47b5-ae76-677ac457bf2f, Intro (Congratulations) / Shout. A-ha's old
recording ae542cde-8a80-4580-922e-70a0df7c8d6c remains current; the edition now
uses track fd37c81b-e5b4-4439-9f50-1bb2ddce95cc for that recording. Dirty Honey
has neither a demonstrated track nor recording redirect in this bounded check.
The actual production-container adapter also reads Dirty Honey's eight-track
current edition, titled Drity Honey in the mirror, without the old recording,
and a-ha's 33-track edition with the unchanged recording on its new track ID.
These cases must not all be treated as one inferred merge.

The updated actual adapter reads Cliff's 14-track edition and exposes its exact
recording redirect to the validator in 62 ms. This is live catalogue-read
validation, not a live database mutation or deployment. The proof script is
saved outside the repository as oct08-real-redirect-proof.mjs. The production
container independently confirms the same redirect in 51 ms. All 23 focused
redirect/active-schema reconciliation checks pass in oct08-redirect-native.log,
without skipped cases. Tests cover
separate namespaces, agreed recording aliases across editions, conflicting
cross-edition targets, contradictory current sources and malformed evidence.

Final full CI passes lint, typechecks, API tests, all 187 frontend tests and
both builds. Log: oct08-redirect-final-ci.log. The first TAP segment contains
one newly failing file-level name, inventory-sidecars.test.ts, with the known
Unable to deserialize cloned data transport error. Its built-in isolation=none
retry passes all 28 cases. The failing-name comparison against the preceding
spatial candidate therefore has no new behavioral regression after that retry.
The 23 focused native checks have no failures or skips.

This candidate supplies and validates evidence; it does not yet transfer file,
sidecar, provider-match or acquisition owners to merge targets. Finish those
admitted transactional transfers with rollback/collision checks and preserved
waiting intent before retrying the live failures or claiming reconciliation is
fixed. Preserve owned obsolete occurrences without authoritative reconciliation.

Live remains 2.21.0 and downloads are paused. Latest completed root scan remains
15759, with 0 removed, 0 added and 12 updated. It predates filesystem witnesses
and cannot authorize strict deletion. The checked writer has no holder or
waiters; cumulative longest hold remains 48,516 ms.

## October 8 spatial stream-evidence candidate

Fresh FFprobe metrics now carry the audio stream profile. The shared quality
classifier uses observed audio facts: an explicit JOC or Dolby Atmos profile can
establish Atmos; ordinary multichannel E-AC-3 alone cannot. Fresh stream results
replace older profile evidence. Acquisition completion also requires observed
Dolby Atmos/object-audio facts, including for the exact same native variant.
Other immersive formats do not inherit Atmos acceptance.

Native probing found a concrete parser failure: music-metadata reported an
ordinary six-channel E-AC-3 MP4 as two channels with no codec. The old decision to
skip FFprobe retained those incomplete facts. Missing/unrecognized codecs now
require FFprobe, and outright tag-parser failure falls back to a fresh stream
probe. Container duration supplies a fallback for raw Dolby streams. A scan's
intermediate review metrics retain the profile instead of dropping it.

Import preparation no longer guesses an unverifiable stream's quality from its
suffix, and both organizer paths reject UNKNOWN quality before file mutation.
This keeps ordinary surround out of both stereo and Atmos imports. Explicit
stereo delivery remains stereo, without inferring a conversion from surround.

The disposable production container generated real ordinary E-AC-3 in MP4 and
raw EC3. Both yield six-channel metrics and remain unverified as Atmos. Active
schema acquisition checks preserve a spatial request for that ordinary surround
file. Profile-bearing positives currently use declared-profile test inputs;
they are not a claim that the bundled FFprobe recognizes every real Atmos file.
The live indexed query returned no DOLBY_ATMOS-labelled TrackFiles. Positive
native Atmos acceptance and the handling of genuinely immersive files that the
bundled probe cannot identify remain release gates. Do not deploy a false
completion or redownload loop in their place.

Live remains 2.21.0, downloads paused, no active downloads/imports. Bounded failed
activity inspection still shows the known five historical events for a-ha,
Dirty Honey and Cliff Richard; it found no newer failed command. Queue status
reports 114,333 waiting album requests. Their retirement remains contingent on
library acceptance, not this quality candidate. The health warning concerns the
known recent refresh failures, not newly demonstrated writer contention.

Final full CI passes all 2,176 API and 187 frontend tests, lint, typechecks and
builds without failing test names or clone retries. Log:
oct08-spatial-final-ci.log. Validation: all 66 focused production-container checks pass, with no skipped
native cases, in oct08-spatial-native-validated.log. The explicit Windows
acquisition verification file also passes all 24 cases. A direct fresh probe of
the generated MP4 reports eac3, six channels, 48 kHz and 640 kbps, with UNKNOWN
quality rather than Atmos. The live dashboard was inspected through the actual
app: Resume queue confirms pause, and its pending section still reads Active.
The writer has no holder or waiting writer; the known cumulative 48,516 ms hold
remains historical evidence, not a new current lockup.

Reference review for the next reconciliation work: Lidarr's SkyHookProxy maps
OldIds and OldRecordingIds into track metadata. RefreshAlbumReleaseService uses
OldForeignTrackIds to identify merges, and RefreshTrackService transfers file
ownership to the explicit merge target before deleting the superseded track and
syncing tags. Discogenius must carry equivalent authoritative redirect evidence
through its catalogue boundary, retain active/waiting acquisition intent, and
reconcile all file/sidecar owners transactionally. A title/position guess is not a
substitute for that identity evidence.

## October 8 delivered fidelity and source-variant consistency candidate

Stereo acquisition verification now reuses the planning audio-facts comparator for
depth/sample rate and codec-aware lossy fidelity. Actual codec names, including
music-metadata's MPEG-4/AAC, use the shared vocabulary. The common legacy quality
classifier also reads that codec before filename suffixes, so known AAC in a .flac
path cannot acquire a lossless label and ALAC aliases remain lossless.

The desired output comes from decideImportedQuality, including the same explicit
downconvert_existing_files option as import. That option participates in the
admission snapshot. Changing it during file verification invalidates the proof.
Cutoff/continue-upgrade preferences remain authoritative. A distinct 24/96 offer
does not silently match a 24/48 file while upgrades are enabled.

Provider facts are expectations, not measurements. The exact same native variant
may deliver 24/48 despite a representative 24/96 estimate, or a VBR stream whose
average bitrate is lower than its encoder target. Avoiding repeated acquisition
requires exact variant ID, full provider track identity, matching file size and
stored probe facts agreeing with the fresh probe. This exception does not bypass
the required imported tier. A different source variant, conflicting provider
identity or stale probe cannot inherit it. Offer facts are never overwritten with
one file's measurements.

Planning already allows an audio variant attached to the source provider album.
Import previously rejected it because it insisted the variant belong directly to
the track. Provenance now also accepts the explicitly identified provider album
when its provider/native ID agree and the actual track has a member occurrence in
that album. It still records the track resource as owner of the file. Wrong or
missing album context and absent membership fail transactionally without clearing
previous provenance. Verification uses the same source occurrence boundary.

Focused checks cover real 16/24-bit WAV files, distinct hi-res offers, unchanged
deliveries below estimates, stale/conflicting facts, lossy codec ranking, explicit
conformity and settings changing during verification, parent variants and provenance
rollback. Native FFmpeg produced AAC targeting 320 kbps with a measured 207.08 kbps
average; that exact measured delivery is accepted, deliberately stale bitrate data
is rejected, and actual-app Resume completes only its explicit track request while
the incomplete whole-edition request remains pending. Native ALAC at 16/48 is
classified as LOSSLESS. Fixture artwork is absent and its scheduled executor is
disabled; the disabled refresh label is not evidence of a production stall.

A readonly live audit reconstructed 80 current plans, at most 20 each for Bastille,
Bakermat, Dirty Honey and Cliff Richard, with no missing identities or duplicate
resource keys in that sample. The bounded a-ha edition window had no current plans
and does not validate its failing refresh. No parent variants were present in this
sample, so the importer inconsistency is not a proven cause of those live failures.
Live remains 2.21.0 paused. The latest checked writer has no holder or waiters;
cumulative longest curation hold is still 48,516 ms, not evidence of a new stall.

Final full CI passes all 2,172 API and 187 frontend tests, lint, typechecks and
builds with no failing names or clone retries. Log:
oct08-fidelity-codec-final-ci.log. Final native verification/audio-facts/provenance/
import checks pass all 67 cases; the full shared audio-utility file passes all 16
checks including native tagging/artwork tools. Logs:
oct08-fidelity-codec-final-native.log and oct08-fidelity-shared-audio-native.log.
The cancellation test's synthetic rename requires DOWNLOAD_PATH on the same
filesystem as its temporary library; /tmp/fidelity-downloads avoids an EXDEV in
that mock. Production file movement was not replaced with this mock.

Remaining quality acceptance includes declared spatial/object-audio evidence.
Consulted .ref_jellyfin/MediaBrowser.MediaEncoding/Probing/ProbeResultNormalizer.cs
and .ref_jellyfin/MediaBrowser.Model/Entities/MediaStream.cs: Jellyfin carries the
probed codec Profile and derives Atmos from its declared profile. Plain E-AC-3
surround is insufficient. Our fresh probe/profile flow needs this validation before
live already-imported spatial requests can be treated as accepted. Full PCM/tag/art
acceptance, broader choice/redirect graphs, legacy artwork migration and witnessed
inventory remain before the authorized live cleanup and download resumption.

## October 8 physical acquisition verification candidate

TrackFiles row presence previously suppressed individual tracks without checking
whether the file still existed or met the requested quality. The command projection
now includes every unverified assignment. Worker admission separates short database
decisions from asynchronous filesystem work, then rechecks the exact request and
selected plan under the write gate before claiming or retiring anything.

Consulted .ref_lidarr/src/NzbDrone.Core/DecisionEngine/Specifications/UpgradeDiskSpecification.cs.
Lidarr separates missing tracks from the quality/profile upgrade decision. Our
verification applies the configured import conversion and cutoff policy to probed
local audio. Provider variant facts describe the desired source/conversion only;
they never prove a local file's quality. A filename's suffix and cached quality
label also cannot substitute for its probed codec and technical facts.

The verifier checks regular files within the real library root, readable audio
metrics, positive duration, canonical duration tolerance, stereo/spatial separation
and the requested quality policy. It compares device/inode/size/mtime/ctime around
probing and checks successful witnesses again before admission. Shared file locks
exclude our writers through the commit callback. Pause, durable import backpressure,
changed request identity and changed catalogue/profile facts prevent stale admission.
External writers cannot be made atomic with our locks; keep other managers from
mutating the files during live acceptance. Metadata parsing is not a complete PCM
decode or an identity fingerprint, so this is acquisition admission evidence, not
proof that the whole library passed audio/tag/artwork acceptance.

Verified explicit-track requests or complete whole-edition offers can retire their
exact waiting row with completed history and Already imported; files verified.
Whole-edition completion requires real assignment count, persisted target count
and current canonical track count to agree. Cached coverage alone cannot authorize
it. Partial offers remain queued for refreshed track information. Missing, unreadable
or lower-quality files are eligible for download rather than inferred completion.
This does not delete library files or bypass strict cleanup inventory witnesses.

Focused checks use real 16-bit and 24-bit WAV files, corrupt/missing files,
duration mismatch, out-of-root paths, file writer admission, changed catalogue facts,
verified completion, incomplete coverage and worker pause/request/backpressure
rechecks. Actual app testing resumes only an isolated fixture queue: the explicit
track request completes, the incomplete whole-edition request remains pending, and
the 390px view shows the green history check and the remaining dependency reason.
The fixture intentionally has no cover source. Live remains healthy 2.21.0 with
downloads paused; scan 15759 still lacks the candidate's filesystem witnesses.

Full CI passes, reporting 2,164 API checks and 187 frontend tests plus lint,
typechecks and builds. The final run encountered the known Node clone transport
failure in edition-monitoring-contract.test.ts; its built-in isolated retry passed
all 21 cases. No behavioural failure remained. The preceding full run passed all
2,164 API checks without that transport failure. Final native checks pass 45
verification/planning/queue cases and both bounded worker continuation cases.
Logs: oct08-file-verification-final-ci.log, oct08-verification-native-final.log
and oct08-verification-native-worker.log.

This earlier candidate compared normalized quality tiers. Source depth/sample rate
affected the desired imported tier; equal-tier fidelity was still outstanding.
The delivered-fidelity candidate above addresses the stereo comparisons;
do not treat these earlier tier checks as full acquisition-quality acceptance.

## October 8 explicit waiting-acquisition reasons candidate

A nullable download-command result conflated unavailable sources, invalid request
identity, missing requested tracks and imported-file rows. Waiting-plan resolution
and command evaluation now return typed ready/blocked results. The existing command
projection delegates to that evaluator, so there is one command-building authority.
DownloadQueue persists a validated reason in its operational payload; the API maps
known reason codes to plain status text. The request remains queued with no error,
no history completion and no silent cancellation. Unchanged reasons do not rewrite
updated_at or trigger a queue kick that could restart admission indefinitely.

A recovered executable exact offer clears its reason. Source changes also clear
previous reasons before new admission. Plan regeneration can leave a waiting row
referencing the old plan ID, so mutation looks up exact library/edition/provider
intent through idx_download_queue_waiting_intent as well as exact plan references.
The lookup excludes claimed requests, requires valid JSON and has an indexed
query-plan regression check. No album-wide or cross-provider substitution.

Consulted .ref_lidarr/src/NzbDrone.Core/Download/TrackedDownloads/TrackedDownload.cs.
Lidarr distinguishes tracked lifecycle state from warning/status messages, including
ImportBlocked and ImportPending. Discogenius uses the same separation here: a
waiting dependency is a status explanation, not a failed download.

Focused checks cover status projection, unchanged-reason write avoidance, repeated
source refresh after plan-ID replacement and reason removal on executable recovery.
Actual app at 390px shows the refresh reason beneath the title without expanding
the controls. A TrackFiles fixture row pointing to an absent file remains queued
with Imported files need verification and no inferred completion. This validates
classification, not the future filesystem/quality verifier or real media download.
All 58 updated production-container checks pass. The actual app also removes
the old reason after source refresh while retaining the paused request and exact
ready offer. Final full CI passes all 2,150 API and 187 frontend tests, lint,
typechecks and builds with no failing names. The final log is
oct08-admission-reasons-final-ci.log. Live stays paused on 2.21.0.

Before automatic request retirement, validate filesystem identity, imported quality
against the requested policy and complete requested coverage. The existing builder
uses imported-row presence for its complete flag; this alone must not authorize
queue retirement, suppress a needed quality upgrade or claim the library clean.
Canonical recording redirects, legacy choice acceptance, artwork migration and
fresh witnessed inventory/file validation remain before live cleanup and resumption.

## October 8 bounded waiting-queue admission candidate

The admission query considered only the first 40 unclaimed rows. Unavailable
plans or a busy provider could occupy that entire window, starving later runnable
requests. The dedicated worker now walks indexed queue-order/id pages. Each turn
reads at most 40 candidates, releases the SQLite write gate, then schedules the
next page through setImmediate. An exhausted pass stops rather than spinning.
A claim restarts from the head for the next free provider slot. External queue
kicks also restart the pass so newly inserted or reordered front items are not
missed. Coalescing preserves that restart even when a continuation is pending.
Pause and durable import backpressure are rechecked on every turn.

Consulted .ref_lidarr/src/NzbDrone.Core/Messaging/Commands/CommandQueueManager.cs
for command ownership/status and queue admission boundaries. Discogenius's
provider wait-table traversal is a separate mechanism. It retains exact blocked
requests rather than pretending they completed or deleting them.

Production-container tests pass all 24 queue cases plus the two worker cases for
continuation, pause and front insertion. They cover 81 unresolved plans before a
runnable request, busy providers, equal ranks, indexed lookup and exhausted passes.
The actual app retains all 82 fixture requests and displays them across pages.
This is admission/UI testing, not proof of real provider download or import.
Final full CI passes all 2,148 API and 187 frontend tests, lint, typechecks and
builds, with no failing names. Log oct08-bounded-admission-final-ci.log.
Test-only compiled liveness invocation initially used
paused/disabled container environment; rerunning with explicit enabled/unpaused
flags passes both cases. Windows compiled liveness invocation hit the existing
source-fixture path mismatch; source-mode validation passes those checks.

Readonly live reconstruction of the five persisted plans for editions 43824 and
32004 succeeds without duplicate resource hashes, incomplete snapshots or identity
errors. The audit opens SQLite only inside the live container with readonly and
fileMustExist. No live writes. This sample cannot certify every legacy plan shape.
Live stays on healthy 2.21.0 with downloads paused. Explicit blocked/completed
request outcomes, larger legacy-choice acceptance, canonical redirects and legacy
artwork retirement remain release gates before fresh inventory and file cleanup.

## October 8 durable acquisition choice candidate

Provider refresh previously deleted plan headers and cleared selection, while
rematching recreated track-match IDs. An unchanged source could therefore become
a different plan. Invalidation now removes derived assignments and marks coverage
stale while retaining headers, sources and the selected reference. Exact typed
track-match edges are upserted and unmatched automatic edges are removed. Retired
edition matches become rejected rather than deleting selected source provenance.
They cannot supply current plans. Removed an unused edition-match deletion helper.

Production plan identity now hashes canonical track/recording MBIDs, scoped native
provider release/track resources, physical edition occurrence and variant identity,
quality, explicitness and primary source. Execution row IDs and album-versus-track
download optimization are not user-choice identity. Primary ordering uses the same
shared rule when constructing keys and persisting sources. Equivalent resource
candidates collapse before persistence. Existing intact current plans are rebuilt
from their bindings before coverage invalidation, without parsing old key strings
or adding shadow catalog fields. Deferred selection references update in the same
guarded transaction. Incomplete snapshots are not reconstructed by guessing.

Pending requests acquire exact library, edition MBID and provider before any plan
replacement or clearing. A missing manual offer retains its selected header as
unavailable even when there are no alternatives. Album locks also protect an
automatically selected offer. The same native resource can recover the saved key
after its membership/match rows disappear and are recreated. Canonical or provider
resource changes produce a different identity and cannot silently satisfy a lock.
The app labels the retained choice as unavailable or needing refresh, with download
disabled when there is no executable offer.

All 62 focused compiled-service checks pass in the production Linux container.
The actual app fixture starts with an old binding-based key, refreshes twice,
retains the manual choice and album lock, persists waiting identity, refuses a
missing source, then restores the exact key and resolves the waiting request after
the source returns under match ID 4. Foreign-key checks stay empty. This tests
provider snapshots and planning, not real provider downloads or media mutation.
The broader Windows focused checks pass 43. Final full CI passes 2,143 API
and 187 frontend tests, lint, typechecks and builds, with no failing names.
The final log is oct08-durable-resource-final-ci.log.

Not deployed. Live remains 2.21.0 with downloads paused. Inspect incomplete or
conflicting persisted snapshots and duplicate legacy shapes during live acceptance;
do not discard intent to get past a failure. Explicit blocked/completed waiting
outcomes and admission past blocked windows, canonical recording redirects/owned
obsolete tracks, and legacy artwork migration still precede release and strict
live cleanup. Fresh witnessed inventory and file/tag/audio verification remain
mandatory before deleting files or resuming acquisition.

## October 8 acquisition ownership admission candidate

Audited the other plan deletion paths after occurrence expiry. Plan replacement
and clearing, provider rematching and provider re-ingestion could remove rows
still held by an executing download/import. They now use one guard inside their
write transaction. Exact acquisitionPlanId references on queued/running commands
and claimed DownloadQueue rows prevent mutation; rejection rolls back upstream
provider item and match writes as well as plan/source/selection writes. SQLite
query plans confirm both ownership checks use their dedicated indexes.

Retry-safe commands release their worker, retain command identity and wait one
minute before another attempt. This dependency wait does not consume failure
attempts. Cancellation and worker ownership fences still apply. Rename/retag and
other non-replayable filesystem commands retain their existing failure policy.
Activity now says Waiting for download or import to finish and omits queue
position suffixes. Completed rows omit the waiting message.

Seventeen new production-schema cases cover the four mutation paths under
download, import and claimed-wait ownership, unchanged transactional snapshots,
quiescent mutation and required writer admission. Metadata lifecycle tests cover
repeated deferral, early-claim refusal, completion and non-replayable mutations.
Dependent service fixtures now build the actual runtime schema and set their
temporary environment before database-bearing imports. The statistics fixture
sets its deliberate unresolved projection after catalogue writes, whose existing
projection triggers otherwise restore it. These changes do not disable triggers.

All 74 focused compiled-service tests pass in the production Linux container.
The running app fixture verifies preserved assignment rows during deferral,
queued waiting text, owner release, successful plan clearing and completed
Activity/Queue history with green checks. This simulates ownership and release;
it does not exercise a provider downloader or claim successful real media import.
There are zero foreign-key violations. Final full CI passes 2,140 API and 187
frontend tests, lint, typechecks and builds without failing names or clone retries.
Final fixture teardown checks pass all 32 tests, with lint and API build also
passing after that teardown change. Earlier failing runs are not acceptance
evidence. Logs are oct08-owned-plan-final-ci.log, oct08-owned-plan-native-final.log
and oct08-fixture-teardown-proof.log in the Windows temporary directory.

The live server remains healthy 2.21.0 with downloads paused and no active media
work. No deployment, live library mutation or cache pruning occurred. Quiescent
provider changes still need stable selected/manual/locked choice handling;
waiting request outcomes/admission and recording redirects remain release gates.
The guard fixes active ownership, not every part of that lifecycle.

## October 8 removed occurrence and held-plan candidate

Catalogue refresh now separates a removed edition occurrence from a canonical
recording identity. Before removing an unowned occurrence, it validates managed
file and sidecar ownership, active media snapshots, standalone waiting requests
and claimed or executing acquisition plans. Those references remain blockers.
Missing track IDs in partial acquisition requests remain unresolved rather than
being silently trimmed.

For a quiescent selected or waiting plan, expiry retains the plan header and
source rows, preferred source key and album lock, marks coverage stale and removes
only the obsolete derived assignment. Exact library, edition MBID and provider
are retained in the waiting payload before any occurrence disappears. Conflicting
intent rolls back. Provider matches retain their recording decision and membership;
only removed edition occurrence context becomes NULL. No substitution by position
or change to the recording MBID is allowed. Later edition-write failure restores
the occurrence, assignment, provider context and original waiting payload.

The production container passes 47 focused active-schema tests. The application
fixture removes an unowned occurrence with a selected, locked TIDAL plan and a
waiting request. It retains the accepted recording match, lock and request, has
zero foreign-key errors and refuses to execute the stale plan. The actual app
shows one surviving track, the retained lock and waiting queue row. The edition
UI still needs a clear stale-source explanation; its current generic source text
does not adequately explain why the selected offer cannot execute.
Final full CI passes all 2,121 API and 187 frontend tests, lint, typechecks and
production builds. The first TAP run has no failed names or clone-flake retries.
Evidence is oct08-catalog-expire-final-ci.log, oct08-catalog-expire-native-final.log
and oct08-catalog-expire-app.mjs in the Windows temporary directory.

This does not merge MusicBrainz recording redirects or repair owned obsolete
tracks. Normal replanning, provider re-ingestion and rematching also remove plan
rows through separate code paths. Verify live ownership and durable selected
intent in those paths before downloads resume. Queue admission beyond blocked
windows, explicit pending outcomes and verified completed-request retirement
also remain open. No live catalogue rows or files changed for this candidate.

A read-only container probe of the three failing obsolete occurrences, Dirty
Honey, Cliff Richard and a-ha, found no additional files with ambiguous occurrence
ownership and no collision with an existing recording-only match edge. This is
a bounded sample. A conflicting unique edge still rolls the whole transaction
back; it does not authorize arbitrary match-row consolidation. The probe is
oct08-occurrence-protection-probe.cjs in the temporary directory and on the NAS.

## October 8 waiting acquisition intent candidate

The previous queue claim fallback selected the first current plan for an album
and quality slot. This could change the edition, library or provider after
replanning. If no command could be built, it deleted the waiting request.
The candidate now resolves only a unique selected current plan for the exact
library, release MBID and provider, taking identity from the durable request or
the retained old plan. Contradictory or incomplete identity fails closed.
Unavailable requests remain queued with their original ordering and payload.
Partial-track requests reject a plan missing any requested track identity.

Active-schema tests cover edition and library alternatives, deleted plan rows,
provider changes, disabled libraries and inconsistent payloads. The production
container passes 33 focused tests. Three repeated claims produce no command or
request mutation, and the actual dashboard retains the pending row on reload.
Full CI passes 2,115 API and 187 frontend tests, lint, typechecks and production
builds. The first TAP run has no failed names or clone-flake retries. Logs are
oct08-wait-intent-ci.log and oct08-wait-intent-native.log in the Windows temporary
directory; the repeated-claim fixture is oct08-wait-intent-app.mjs there.
The live deployment remains healthy 2.21.0 with downloads paused. Scan 15759 is
still the latest completed whole-library scan returned by the live command API;
it provides no candidate filesystem witnesses. No live files were changed.

This prevents wrong acquisition and request loss. It does not yet unblock the
held obsolete catalogue tracks. Waiting requests need explicit replan/blocked
outcomes, verified completed-request retirement and admission beyond the first
40 blocked rows before resuming downloads. Selected/manual preferences, claimed
downloads and import handoffs must survive catalogue reconciliation. Lidarr's
RefreshTrackService updates stable foreign track IDs and transfers known file
ownership for merges; it does not provide Discogenius's provider-plan lifecycle.

## October 8 fresh proxy publication candidate

Catalogue artwork warming now publishes only 250/500 JPEG display derivatives,
or the 250 video derivative. It records source identity and derivative hashes in
the active schema, stages bytes before writer admission, and rechecks the source
and preference before publication. An intact repeat performs no fetch or writes.
Missing or same-size corrupted proxies invalidate refresh eligibility; source
markers alone no longer hide damaged display files. Late fetches cannot replace
a newer source. Library imports fetch the selected original into the sidecar;
retag remains local and never promotes a proxy to an original.

Legacy originals and JSON manifests are deliberately retained until a complete
witnessed migration. This candidate changes fresh writes, not the existing live
94 GB cache. Do not manually wipe it. Library image replacement now has the
tested recovery candidate described below. The embed-without-sidecar
configuration still needs acceptance before release. It currently relies on a locally available master and
must acquire an original explicitly without changing local-only retag behavior.

Jellyfin's ItemImageProvider skips provider work when configured image roles and
limits are satisfied; ImageSaver uses stable media-local role names and indexed
backdrops. Discogenius uses bounded role ownership and durable selected-source
records, rather than copying Jellyfin's direct overwrite or unrestricted extra
image generation. Existing user artwork and review companions remain protected.

Production-image checks pass all 118 focused artwork, identity, route and
sidecar tests. The actual app imported a WebP original as a full-size JPEG,
survived complete deletion of its disposable test cache by rebuilding only two
proxies from the tracked library master, and completed RetagFiles 1. The resulting
FLAC embeds a 1200x1200 JPEG, canonical identifiers and lyrics, with unchanged
decoded audio and sidecar hash, zero foreign-key violations, and a repeat UI
preview reporting no files need retagging. Screenshot capture timed out twice;
the visible accessibility state and container proof were retained instead.
Evidence: oct08-proxy-native.log, oct08-proxy-app-before.log and
oct08-proxy-app-after.log in the existing temporary release audit directory.
Full CI passes all 2,094 API and 187 frontend tests with no failed names or
clone-flake retries, plus lint, typechecks and production builds.

Read-only live verification still reports healthy 2.21.0, unchanged image digest,
downloads paused, and no active downloads/imports. No live deployment, cache
pruning or library mutation was performed for this candidate.

## October 8 artwork replacement recovery candidate

Both fetched/converted image materialization and local-only master copying now
persist replacement intent before publishing bytes. ArtworkMutationJournal owns
the stage and short-lived previous-image hardlink; its acknowledgement commits
with the exact library link and selected-source hash. Recovery is part of the
existing startup/watchdog FileMutationJournal gate, and unresolved artwork
recovery errors appear in Health and block further disk commands. No permanent
image archive or hidden alternate-original directory is introduced.

Prepared replacements roll back to the original inode and bytes. Committed
replacements retain the new image and remove only their verified previous copy.
Stage, backup, destination, ownership and exact MetadataFiles linkage are
validated. An external replacement, even with identical image bytes, is preserved
and leaves recovery evidence. A newer catalogue source does not block rollback
or get reverted by it; changes to the file's library ownership do block recovery.

Validation covers real child-process exits before publication, after the backup,
before the provenance transaction commits and after commit, plus failed local
provenance writes, new-file rollback, external replacements and ownership changes.
Full CI passes 2,109 API and 187 frontend tests, with no failing names or clone
retries. The final production image passes 110 focused journal/artwork/health
tests. Lint, typechecks, builds and image packaging pass.

The actual test-container server boot restored sidecar SHA-256 dd818e65... from
an interrupted replacement before serving requests. A retry then completed the
new sidecar, preserved MetadataFiles ID 1 and settled its intent. App-driven
RetagFiles 1 completed with canonical identifiers, lyrics and the replacement
1200x1200 JPEG, unchanged decoded audio and zero foreign-key violations. Repeat
preview reports no files need retagging. Evidence in the temporary release audit
directory: oct08-art-journal-final-ci.log, oct08-art-journal-native-final.log,
oct08-art-journal-startup-proof.log, oct08-art-journal-retag-proof.log and
oct08-art-journal-ui.png.

Live reads confirm scan 15759 remains completed on 2.21.0 without candidate
filesystem witnesses. Dirty Honey refresh 15768 is still held by obsolete track
523b86af-c7d2-4375-be7d-17748471aafe in an acquisition plan. This journal does not
resolve that separate catalogue/planning failure. No live artwork change,
deployment, queue clearing or cleanup has been performed. Downloads stay paused.

### Held catalogue tracks: October 8 read-only comparison

The live configured authority is local MusicBrainz, not Servarr. Read-only
better-sqlite3 inside the running container and read-only PostgreSQL queries to
that mirror show two different reconciliation cases:

- Dirty Honey edition f73393b5-29d7-4347-a70d-3bec9dadbbf1 has 14 stored target
  tracks in its current composite plans, but the mirror now returns 8. The old
  first track, When I'm Gone, recording f009ec3e-9952-4c3b-b4ab-6c0fa678cdce,
  is absent from the current edition and has no recording redirect. Current
  track 1 is California Dreamin', a different recording. Never rebind by position
  or relabel this held track as the new first track.
- Cliff Richard edition 5b198534-a6de-434a-a7ce-e5195311e45a has a real recording
  redirect from Shout, 51495e16-4c34-4bcf-9b0e-eddec1d7e311, to
  3fff979b-60bb-47b5-ae76-677ac457bf2f, Intro (Congratulations) / Shout. Its new
  occurrence is track 774c2f1d-91c6-4967-9f4b-2af60cf30971 at position 1.
  This needs canonical merge handling and fresh duration/coverage validation,
  not an automatic assertion that the old provider resource covers the medley.

Neither sampled obsolete track has a TrackFiles row. Dirty Honey has four
current plan bindings; Cliff Richard also has an accepted ProviderTrackMatches
row and a current Deezer plan. This bounded sample does not prove all old tracks
or plans are unowned. Before changing anything, preserve library selection and
queued acquisition intent, distinguish removed edition slots from canonical
recording redirects, handle all owned dependants transactionally, and replan
against the refreshed canonical edition. Lidarr's RefreshTrackService merge
path transfers file ownership and retags updates; it is useful guidance, not a
license to discard Discogenius's extra plan/provider references.

Evidence: oct08-held-tracks-live.log, oct08-held-tracks-catalog-live.log and
oct08-held-tracks-redirects-live.log in the temporary release audit directory.
These probes only read container SQLite and mirror PostgreSQL; no live rows or
files were changed. This finding is a remaining release prerequisite.

## Intended behavior

Robert's October 4 clarification defines three separate policies:

- Remove unmonitored files removes managed releases that are no longer monitored.
- Delete empty folders removes empty directories inside a configured library root.
- Delete untracked files is an optional strict policy. After a successful complete
  inventory, it removes files owned by neither the managed library nor the
  unmapped review inventory, then prunes directories that became empty.

The third policy is not implemented or enabled by the current monitoring toggle.
Do not reinterpret remove_unmonitored_files as strict cleanup.

## Inventory before deletion

1. Enumerate the configured roots, including plain-name/legacy directories,
   files directly in a root, and files in disabled media categories. Category
   preferences must not make existing media invisible to ownership checks.
2. Match supported audio/video using canonical identity and explicit edition
   context. A folder name is a discovery hint, not a track or edition decision.
3. Register unmatched applicable media in UnmappedFiles. A wholly unmatched
   album directory appears as one expandable review group; a remaining track
   in a matched album appears as that individual track. Individual videos stay
   individual items. Grouping must preserve per-file identity and review actions.
4. Associate artist art/NFO with the artist, album art/NFO with the edition or
   album as appropriate, lyrics with the exact track/recording occurrence, and
   video assets with their recording. Preserve sidecars belonging to an unmapped
   media group until those associations can be confirmed. A file must not be
   declared disposable merely because its parent media awaits identification.
5. Only after all required discovery and persistence completes successfully,
   build a deletion plan for remaining unsupported/unowned files. Do not delete
   files in a folder skipped because of a read error or interrupted scan.
6. Before each deletion, recheck current DB ownership and filesystem identity.
   Respect file locks, pending file mutations and media rewrite temporary files.
   Keep the work bounded, journal outcomes, stay within the configured root and
   never follow a symlink into another directory. No root-wide recursive delete.
7. Prune genuinely empty parents without deleting the root, and report actual
   counts plus actionable refused paths. An unchanged repeat scan is a no-op.

The strict setting should default off and have concise explicit help stating
that files absent from both inventories are permanently removed. Supported
unmapped music is protected even when strict cleanup is on. JSON/executable
leftovers are not protected merely by an unmapped folder's path prefix.

## Current bounded fix

Routine artist scans now include an unambiguously identified plain-name sibling
of the configured artist folder. Exact artist-name lookup uses the existing
case-insensitive catalogue index and rejects duplicate names. Explicit unknown
MBIDs never fall back to an artist-name match. Custom configured folder matching
falls back only to artists represented in LibraryArtists, avoiding a full
ArtistMetadata read for every unrelated directory.

Whole-library scans now finish artist reconciliation with a resumable inventory
of all configured roots. Each dispatch checks at most 100 entries or 15 seconds
before yielding. Directory/file cursors survive a command continuation or DB
reopen. Ownership lookups use indexed paths in TrackFiles, MetadataFiles,
LyricFiles and ExtraFiles. Existing review entries, including ignored files, are
preserved and do not need another metadata probe. New unowned media is registered
for review; this stage does not automatically identify unknown artists or albums.

The traversal skips symlinks and reserved system directories. Read failures stop
the command; missing roots are recorded in its checkpoint. Orphan-record pruning
now requires the file's library root to be accessible before treating an absent
file as deleted. This guards unavailable roots, but does not detect an empty
directory left behind by a failed mount; strict deletion still needs a separate
root-availability and inventory-completeness gate.

Native-container validation used real generated FLACs directly in a root and
under an unknown artist/album. The actual RescanFolders handler registered both,
preserved an ignored file and an unsupported JSON file, and added nothing on a
repeat scan. The app displayed both review rows and opened the correct album
directory in Manual Import. Active-schema tests also cover restart recovery,
concurrent import, inaccessible directories, unavailable roots and symlinks.
Full CI passed 1,970 backend and 186 frontend tests before these inventory changes
shipped in 2.21.0. Automatic identification of unknown folders, complete sidecar
ownership and strict cleanup remain release gates.

## Lidarr as a secondary index

The live October 4 API check found renameTracks=false, writeAudioTags=no,
scrubAudioTags=false, deleteEmptyFolders=true, watchLibraryForChanges=true and
rescanAfterRefresh=always. Rename and tag writing are independent settings.
embedCoverArt=true does not mean covers are being rewritten while tag writing
is disabled. Keep the rename/tag settings disabled during reconciliation.

After Discogenius passes its inventory and tag acceptance gates, snapshot Lidarr
configuration/database and run controlled rescans on Bastille and Bakermat.
Compare physical paths, embedded release/track MBIDs, selected editions and
unmapped counts. Determine why existing files remain sticky before requesting
an explicit reassignment; a full rescan is not proof that Lidarr selected the
same editions. Keep both apps connected to the shared files, with Discogenius
owning writes while Lidarr provides the secondary database.

## Acceptance cases before release

- Manually copied recognized album becomes exact tracked edition/track rows.
- Unrecognized album is one review group; one unresolved album track is one row.
- New plain-name artist folder is discovered without an explicit import action.
- Artist names shared by two catalogue identities remain unresolved.
- Sidecars do not lose ownership when media moves or edition identity changes.
- Strict cleanup preserves tracked and unmapped media, but removes unsupported
  leftovers, with nested empty folders pruned and root retained.
- Concurrent import, interrupted scan, inaccessible directory and symlink cases
  cannot turn an incomplete inventory into a deletion plan.
- Repeat scan, rename and retag previews show no changes for settled files.
- Controlled Lidarr rescans account for standard/deluxe coexistence without
  renaming or retagging the shared files.

## October 6 cleanup hardening

The next full rename/retag and cleanup is explicitly authorized once its
prerequisites pass. Strict cleanup is not implemented and must not be substituted
with remove-unmonitored cleanup.

On `codex/managed-library-cleanup`, empty-parent pruning now returns the actual
removal count, never removes the configured root, stops at retained files and
refuses directory links anywhere in the traversed ancestor chain. A Windows
case-insensitive root regression caught an infinite traversal in the candidate;
the corrected check recognizes root aliases and bounds ancestor traversal.

Rename deduplication now requires identical sidecar bytes as well as matching
scope. The destination artist-field alias is corrected. A lyric collision with
another tracked row must share its exact TrackFiles parent. A DB claim on an
absent target does not justify deleting the source. Different artwork and lyrics
remain conflicts. Hashing runs outside writer admission; the staged file is
reverified and filesystem witnesses are checked inside the commit. Tests inject
a changed retained lyric and a failing DB commit and verify source restoration,
preserved ownership and a settled journal. Native Linux checks passed 81 tests,
with the Windows-only casing test skipped there and passing on Windows.

An interrupted full test runner could previously be mistaken for a recoverable
clone flake when its partial output contained an earlier clone failure. The
runner now requires a completed top-level TAP plan and refuses retries after a
termination or spawn error. Fault-injection subprocess checks confirm interrupted
and terminated runs fail while a completed clone-flake run can still retry.
The earlier interrupted candidate CI is discarded as validation evidence.

All eight live failed artist refresh retries completed successfully on 2.21.0.
A fresh read-only audit decoded the earlier eight audio conflict pairs into
32-bit PCM hashes: seven pairs agree, including two whose edition tags disagree;
one target is now absent. Equal audio alone does not establish edition ownership.
Do not consolidate these paths until current tracked/review ownership and the
intended edition are reconciled. No live rename, retag or deletion was started
during this hardening work.

The subsequent ownership check found all seven existing destinations tracked as
rows 36044-36050, with matching canonical track/edition IDs and stereo quality.
They are same-slot duplicates; two still carry outdated embedded edition tags.
Consolidation must preserve their sidecar associations and repair tags, using
exact row IDs and the mutation journal. The absent target belongs to source row
35761 and should be reconsidered through a fresh rename plan.

The final full CI completed with no new assertion failures. A provider-registry
clone-deserialization failure passed its isolated retry. All 186 frontend tests,
lint, types and builds passed. These candidate fixes remain undeployed until the
broader cleanup and duplicate-consolidation requirements are satisfied.

## October 6 completed live inventory and traversal checks

Live root scan 15506 completed on 2.21.0. Its persisted inventory reports 63,445
files, 3,802 directories, 26 new review files and no missing roots. Artist
reconciliation reported 187 additions, 61 updates and no removals. The actual
Activity view shows completion and no active jobs. Unmapped shows 79 files,
including grouped Bastille mixtape folders. The latest 26 review rows span ten
directories; a read-only audit found no JPG/PNG/WebP/NFO/LRC/SRT/TXT sidecars in
those directories. This bounded check is not a whole-library sidecar audit.
Downloads remain paused, with no active downloads or imports. The last 45
minutes of container logs showed no new scan or writer errors.

The cleanup candidate now rejects a discovered directory disappearing rather
than silently finishing without its contents. It checks ancestor links and
containment before listing directories, including empty ones. Root device/inode
identities and the current directory identity survive continuations; replacing
either invalidates the stored cursor. A root missing when inventory starts stays
recorded as missing even if it reappears later. Existing checkpoints without
these witnesses remain readable, but cannot supply the new identity evidence
for a future deletion gate. Detecting an empty failed mount and rechecking the
full inventory before deletion still require further work.

Actual-app testing also confirmed a remaining scan split. The dashboard Scan
Library Files action uses mediaFile/scan-roots with addNewArtists=true, entering
the older discovery handler. The RescanFolders system task uses the resumable
inventory with addNewArtists=false. The former registered an unknown album FLAC
but reported no file changes, and produced no rootInventory checkpoint. The
latter registered a FLAC directly in the root, persisted witnesses for all three
roots and reported its new review entry. Its repeat added nothing, kept the
ignored review decision, retained the unsupported JSON file and preserved the
album FLAC's SHA-256. Activity and Unmapped showed the actual results. Shared
coverage/completion evidence and truthful discovery counts remain required;
legacy completion must not be treated as deletion authorization.

The reference Lidarr DiskScanService routes RescanFolders through one Scan
method with AddNewArtists passed into the shared import decision configuration.
It checks the configured root before cleaning a missing artist folder, and skips
an empty scan folder before cleaning its media records. See
`.ref_lidarr/src/NzbDrone.Core/MediaFiles/DiskScanService.cs`, Scan and Execute.
Use that common execution structure here: persist new-artist discovery as a
phase, reconcile artists with the existing bounded scan work, then complete the
same all-root inventory. Preserve AddNewArtists as an identification policy,
not a switch to a separate uncheckpointed traversal. An empty root with existing
ownership needs to block orphan-record pruning as well as strict file deletion;
genuinely unused empty roots need not prevent reviewing other healthy roots.

Ten active-schema inventory tests passed on Windows and in the final native
Linux image. The final full CI passed with no newly failing test names against
the previous candidate; the same provider-registry clone-deserialization failure
passed its isolated retry. Lint, types, builds and all 186 frontend tests passed.
The root witness is verified using the ancestor checks, avoiding separate root
filesystem checks for every file. The rebuilt final app registered two real
stereo FLACs, including a loose file directly in the root, then completed a repeat
scan with no additions and stable review row IDs. These traversal fixes remain
on the cleanup branch and are not deployed to the live 2.21.0 container.

## October 6 Lidarr comparison and shared scan execution

The following reference flows were checked directly in the local Lidarr checkout:

| Concern | Lidarr behavior | Discogenius decision |
| --- | --- | --- |
| Scan entry points | `MediaFiles/DiskScanService.cs` routes RescanFolders through one Scan flow with AddNewArtists in its import-decision configuration. It skips empty folders and guards unavailable/empty roots before cleaning missing records. | Manual and scheduled commands now share artist reconciliation and all-root inventory. Optional discovery settles into the checkpoint once before inventory. Empty roots cannot establish that missing owned or review files were deleted. |
| Ownership cleanup | `MediaFiles/MediaFileTableCleanupService.cs` compares scoped TrackFiles with disk paths and removes missing records. | Recheck file absence and root health after writer admission, before removing the exact ownership row. This closes the race where a file reappears during the wait. |
| Sidecar ownership | `Extras/Files/ExtraFile.cs` and `ExtraFileService.cs` retain artist, album and exact TrackFileId relationships; deletion events remove linked extras. | Consolidating duplicates must rebind applicable sidecars to the retained exact row, rather than invoking deletion of their parent and losing its extras. |
| Rename collisions | `MediaFiles/RenameTrackFileService.cs` skips existing destinations and same filenames; successful renames trigger empty-subfolder cleanup. It does not resolve collisions using random suffixes or decoded-audio hashes. | Preserve collisions unless exact ownership, edition, quality and media evidence permit journaled consolidation. Count actual empty directories removed and stay within configured roots. |
| Upgrade replacement | `MediaFiles/TrackImport/ImportApprovedTracks.cs` can remove existing album files when upgrading. | Do not copy this policy wholesale: multiple editions, stereo and spatial files may coexist here. Equal decoded audio across different editions is not deletion authority. |
| Retag input | `MediaFiles/AudioTagService.cs` derives tags from the stored track/release/album/artist graph and local artwork. | Keep retagging on persisted canonical data and local assets. Discogenius's current apply path follows this boundary; an unused private enrichment helper remains a code-cleanup item, not an active retag dependency. |

The isolated app's manual Scan Library Files action registered three generated
FLACs: one unknown album, one loose stereo root file and one loose file in the
disabled spatial library. Activity reported three files added for review.
Discovery registered one and the common root inventory registered two, with
identities for all three roots and `complete=true`. A second manual run reported
no changes, kept all review row IDs and persisted a complete inventory again.
New-artist discovery remains one potentially long phase; this change removes the
alternate command execution path, not every repeated filesystem enumeration.
It also does not implement strict deletion or audio duplicate consolidation.

Forty-one focused tests passed in the Linux image, including empty-root
preservation, files reappearing while waiting for the writer, discovery restart
and failure, review-count accuracy and root traversal witnesses. Downloads on
the live 2.21.0 app remain paused. This candidate has not been deployed.

Final `yarn ci` passed: all 2,019 API tests and 186 frontend tests, lint,
typechecks and builds. There were no new failing test names against the previous
candidate; this run had no clone-deserialization retry. The scheduled-policy
RescanFolders test also completed with the same root witnesses and no additions.
Evidence is in the operator audit directory: `oct06-lidarr-shared-ci.log`,
`oct06-shared-native.log`, `oct06-shared-app-checkpoints.log` and
`oct06-shared-scan-ui.png`.

## October 6 verified audio consolidation candidate

Rename apply now distinguishes a verifiable same-edition stereo duplicate from
an ordinary collision. The candidate must have matching exact canonical track,
edition, recording, artist and library identities; those identities must agree
with the current catalogue graph. Local quality facts must agree. Both files
must probe as one lossless FLAC/ALAC stereo stream with matching codec, sample
rate and bit depth, and their complete decoded 32-bit PCM hashes must match.
Providers are not identity evidence. Different editions or spatial files are
not consolidated. Unsupported or ambiguous candidates remain conflicts.

Decoding happens outside database writer admission under both media-file locks.
The source is staged through FileMutationJournal. Exact source/destination row
snapshots and filesystem witnesses are checked again inside the transaction.
MetadataFiles, LyricFiles and ExtraFiles references transfer to the retained
TrackFiles ID before deleting the source row. Sidecar row IDs and library links
are preserved; the expanded rename selection then handles their physical moves.
The journal settles the staged deletion and empty-parent pruning counts actual
directories removed. A failed transaction restores the source and associations.

The rename preview now lets users select matching ownership candidates for
verification. Its message says the destination is kept only after equal audio
is proved; it does not label a candidate as an already proved duplicate. Ordinary
conflicts remain disabled. A frontend interaction test verifies selection and
the submitted ID, alongside active-schema tests for different editions, spatial
slots, missing identity, incompatible sample/bit-depth facts, different samples,
destination changes, transaction rollback and repeat behavior.

The rebuilt Linux image passed 50 rename/journal tests. Actual-app testing used
generated FLACs with equal audio and different comments plus a linked lyric. An
initial fixture ownership error refused hard links and preserved both files;
after correcting ownership to the app user, the UI queued and completed rename.
The destination retained TrackFiles ID 2, the lyric retained its row ID and moved
with track_file_id=2, the Imports folder disappeared, and the journal was empty.
A repeat rename preview had no changes. The app then retagged that retained file,
writing the fixture canonical identifiers and lyrics; ffprobe confirmed the
tags and a repeat preview had no changes. Its decoded PCM SHA-256 matched a
reproduced original fixture. Evidence: `oct06-audio-app-proof.log`,
`oct06-audio-retag-ui.png`, `oct06-audio-duplicate-final-native.log`.

These changes remain a candidate, not a live cleanup result. The seven verified
live duplicate pairs still require controlled deployment, fresh ownership
proof and consolidation; the two stale retained edition tags require retagging.
Strict unowned-file cleanup and full-library artwork acceptance remain open.

Robert's current goal additionally authorizes removing unresolved Unmapped media
at the final managed-library reconciliation, after identification has been
attempted and the complete inventory is validated. Treat this as an explicit
one-time disposition, separate from the ordinary strict setting that protects
Unmapped review media. Record exact paths and outcomes rather than silently
changing the default policy for future scans. The download queue may be cleared
and resumed only after cleanup, library-wide rename/retag and their acceptance
checks establish the requested clean live library.

Final full `yarn ci` passed with all 2,029 API tests and 187 frontend tests,
lint, typechecks and builds. No clone retries or failing test names occurred.
`oct06-audio-duplicate-final-ci.log` records this final source version; the
earlier CI log predates the preview action and is not its acceptance evidence.

## October 7 unowned-file recovery and current live evidence

The local candidate adds LibraryCleanupJournal for files that have no managed
ownership row. It records an operational intent without inventing a TrackFiles
claim. Preparation and commit require a completed whole-library scan, finished
artist reconciliation and discovery when requested, unchanged scan configuration,
all configured roots present, and unchanged filesystem identities for every
root. A legacy inventory without these witnesses is insufficient.

Each intent records the exact file witness and stages the file through a
non-overwriting hard link in its original directory. A transaction rechecks
ownership and inventory before committing removal. Recovery restores an
uncommitted file or finishes a committed removal, even after command history
is pruned. A recreated source is preserved and leaves an actionable pending
intent. Pending cleanup shares startup/watchdog recovery, disk-command admission
and recovery health reporting with tracked-file mutations. Scan discovery skips
cleanup temporary files; reserved system directories cannot be selected.

Default preparation protects all Unmapped rows, including ignored ones, and
rejects supported media that has not been identified or registered for review.
An explicit exact review disposition exists for the separately authorized final
reconciliation, but this maintenance run preserves review media. The bounded
cleanup planner and applicable sidecar ownership reconciliation are still open.
There is no public cleanup action and no production caller of this journal yet.
Do not enable strict deletion from these recovery tests alone.

Ten active-schema cleanup tests pass on Windows, including a separate Node
process that exits after staging. Recovery restores the original bytes after
reopening the database. The rebuilt Linux image passes 34 cleanup, tracked-file
journal and scan tests. These checks cover process interruption, ownership
races, root replacement, changed configuration, transaction rollback and
recreated files; they do not establish power-loss durability. Evidence is in
`oct07-cleanup-journal-source.log`, `oct07-cleanup-journal-process.log` and
`oct07-cleanup-journal-final-native.log`.

The Lidarr reference still confirms the relevant boundaries: DiskScanService
checks root availability, reconciles known files and persists unmatched media;
RenameTrackFileService skips occupied destinations and prunes empty subfolders
after successful moves; MediaFileDeletionService removes bytes through its
recycle-bin provider before removing the ownership row. Discogenius's optional
strict unsupported-file cleanup goes beyond those flows, and needs its own
complete ownership and recovery checks.

Live inspection on October 7 confirms healthy 2.21.0 at revision
f4e46cbe83cccf5423336da6b68a94f8d6de2eb9, with downloads paused and no active
downloads, imports or commands. Scan 15506 has aged out of history. The latest
whole-library scan, 15759, completed with 62,973 files, 3,792 directories, zero
new review files and no missing roots. It lacks the candidate's root identity
witnesses and cannot authorize strict deletion. Its different file count does
not establish which files changed or why.

New refresh failures 15602 for a-ha and 15628 for Dirty Honey concern obsolete
catalogue tracks referenced by accepted provider matches and acquisition plans,
not imported files. Both have a selected automatic TIDAL plan held by a waiting
DownloadQueue row. Preserve that acquisition intent during reconciliation;
blindly deleting bindings or treating these plans as unused would bypass the
existing safety checks. The earlier eight refresh retries remain successful.
The local cleanup candidate has not been deployed, and no live files were
deleted or retagged during this inspection.

The fresh local production container exposed a separate monitoring handoff
failure: RefreshMetadata and CheckHealth completed, but their follow-up queue
writes logged SQLITE_BUSY in acquireSqliteWriteMutexSync. Command outcome
persistence already used async admission; queueNextMonitoringPass did not.
The candidate now awaits the same async writer admission for that follow-up.
A contention test queues an unrelated writer after completion and verifies
that its timer runs and exactly one terminal DownloadMissing pass is queued.
With the former synchronous handoff restored, that same test fails with the
observed SQLITE_BUSY and no terminal pass; it passes with async admission.
The rebuilt fresh container completed all six startup/scan commands without
the earlier error. This is a local empty-library startup check, not evidence
that every live contention source is resolved. Fifty-one native cleanup,
scan and monitoring tests passed. Runtime evidence is in
`oct07-cleanup-runtime.log` and `oct07-cleanup-chain-runtime.log`.

An existing write-gate test failed once during full validation because it
assumed cold dynamic imports would reach admission in invocation order. Both
writes were serialized in the opposite order and the isolated rerun passed.
The test now explicitly waits for the first writer to enter, holds it until
the competing writer has yielded, and checks that their work cannot overlap.
This removes the timing assumption without weakening the serialization check.

Final `yarn ci` passed all 2,040 API tests and 187 frontend tests, lint,
typechecks and both builds. The main TAP run has no failing names or clone
retries. `oct07-cleanup-chain-final-pass-ci.log` records the accepted source;
earlier failed/preliminary logs are retained as diagnostic evidence. The final
native run passed all 51 scoped tests in
`oct07-cleanup-chain-accepted-native.log`. This candidate remains undeployed.

## October 7 exact sidecar inventory

The root inventory now reconciles lyrics, edition covers/NFO and video
thumbnails from their physical playable siblings. It uses indexed exact paths
and the active canonical FK graph, not a provider ID or a first matching
provider occurrence. A lyric requires one physical audio file. Folder art/NFO
requires agreement on artist, album, edition and library slot; a shared cover
retains every confirmed library association. Different editions or two audio
formats with the same stem remain unresolved. Unmapped companions, including
ignored media, protect their applicable sidecars without fake catalogue rows.

Testing found that ExtraFileService could infer a physical file from a library
ID alone when that library contained only one playable file. A library now
only scopes an actual identity predicate; it cannot attach folder metadata to
an arbitrary track. Sidecar association and ownership writes commit together,
after rechecking the physical witnesses and current ownership under admission.

Actual-app testing exposed an additional hole: the artist scan could create
sidecar rows with no edition identity, which the root inventory then skipped
as already owned. The new pass repairs missing identity while keeping row IDs,
provider facts, quality and rename information. A conflicting non-null canonical
assignment remains unresolved. Confirmed folder metadata can shed an incorrect
track link only when that link points to a confirmed sibling in the same folder.
Activity includes the sidecar changes instead of describing such a run as
having no changes.

Cleanup preparation, staging and commit now refuse recognized sidecars whose
ownership has not been settled. The shared media extension set also includes
APE, MP2, WebM and TS, which artist scans already recognized; these files cannot
be mistaken for unsupported cleanup debris. Artist-level artwork/NFO resolution,
review-sidecar persistence/grouping, explicit conflict diagnostics and the
bounded strict cleanup planner are still open. This is not permission to enable
strict cleanup or clear the live queue.

Sixteen active-schema sidecar tests cover physical identity, different edition
folders, ambiguous stems, shared-library covers, videos, missing-identity repair,
conflicting assignments, transaction rollback, writer races and unchanged repeat
inventory. Standalone catalogue videos can retain exact physical thumbnail
ownership without an album edition; YouTube-only catalogue identity does not
require an invented MusicBrainz ID. Windows root casing is tested explicitly.
The final focused Windows run passes 48 tests; rebuilt native Linux passes 47
with the Windows-only casing check skipped. Full `yarn ci` passes all 2,058 API
and 187 frontend tests, lint, typechecks and builds, with no failing names or
clone retries. Evidence is in `oct07-sidecar-final-accepted-ci.log` and
`oct07-sidecar-final-accepted-native.log`.

In the running local app, Scan Library Files first exposed incomplete cover and
lyric identity. After rebuilding and correcting permissions on the test-only
seeded volume, a second UI-triggered scan repaired both rows, retaining ID 1 in
each table and assigning their edition. The lyric kept TrackFiles ID 1 and the
cover kept a null track link. Activity showed two sidecars linked. A third
UI-triggered scan completed with no file changes and preserved those IDs. The
full SHA-256 of the generated stereo FLAC, LRC and 1200px JPEG was identical
before and after. Evidence: `oct07-sidecar-app-proof.log`,
`oct07-sidecar-app-after.log`, `oct07-sidecar-app-repeat.log`,
`oct07-sidecar-bytes-before.log`, `oct07-sidecar-bytes-after.log` and
`oct07-sidecar-repeat-ui.png`. A fourth UI scan on the final rebuilt image
completed as command 9, with unchanged ownership and file hashes; evidence is
in `oct07-sidecar-final-app-repeat.log` and `oct07-sidecar-final-bytes.log`.
These local checks do not establish live artwork
storage or whole-library cleanup acceptance. The live server remains 2.21.0,
with downloads paused; these sidecar changes have not been deployed.

## October 7 artist ownership and scan-time asset deletion

Artist pictures and artist.nfo now resolve from an exact persisted LibraryArtists
path in the current library root. Nested/custom and absolute paths are supported;
root-level files, same-name guesses, conflicting artists and paths belonging to
another root remain unresolved. Shared directories retain only the libraries
whose artist membership actually names that directory. The lookup has exact and
Windows case-insensitive path indexes; admission rechecks the current mapping.
Artist assets remain artist-scoped, without a fabricated edition or track link.

Actual app testing found a separate destructive flaw before deployment: the old
scan-time deduplication grouped an artist picture with an incompletely identified
album cover and deleted the picture because its folder had no adjacent audio.
Absence of adjacent audio is not evidence that an artist asset is rename debris.
The synchronous deduplication now merges only database aliases of the same
resolved path. Distinct physical paths and their ownership remain intact for
verified journaled cleanup; the unverified stale-sidecar deletion helper and
its audio-presence heuristic were removed. This deliberately leaves genuine
physical duplicates until the verified planner/rename workflow resolves them.

Twenty-four active-schema inventory tests cover the previous edition/track
cases plus custom artist directories, shared-root ownership, conflicting artists,
wrong roots, indexed access, writer races and physical asset preservation.
The combined focused Windows runs pass 62 tests. Rebuilt native Linux passes
92 of 94 inventory/cleanup/root/extra-ownership/library-file checks, with two
Windows-only casing tests skipped and no failures.

The earlier direct library-files test invocation exposed an import-order issue:
managed-artists loaded database configuration before the file set its fixture
environment, so it opened the local developer database. No running container
mounted that directory and the NAS was not touched. That import is now deferred
until after fixture setup; focused reruns used explicit isolated configuration.
The full runner already supplies isolated configuration before imports.

Final full CI passes 2,066 API and 187 frontend tests, lint, typechecks and builds, with no failing names or clone retries (oct07-artist-asset-accepted-ci.log). Its earlier one failing name was the stale-lyric recovery test, which expected immediate cross-path row deletion. The updated test verifies recovery first, then guarded missing-row pruning without changing recovered bytes; all nine backfill tests pass on Windows and rebuilt native Linux (oct07-artist-asset-backfill-focus.log and oct07-artist-asset-accepted-backfill-native.log).
Artist ownership without a persisted membership path, review-sidecar persistence,
actionable conflict diagnostics and bounded strict cleanup planning remain open.
Do not deploy strict deletion or clear/resume the live queue on these checks alone.

On the final rebuilt local app, UI scan 9 retained the restored real JPEG as
MetadataFiles ID 4 (ArtistImage), kept artist.nfo ID 3 artist-scoped and retained
album cover ID 2 with its edition. UI repeat 10 completed with no indexed or
updated files and a complete five-file inventory. All three metadata IDs and
the exact lyric link survived; the artist JPEG/NFO SHA-256 values matched their
pre-scan values. The old deletion was reproduced only in this disposable local
fixture. Its scheduled RefreshArtist failure is expected because the offline
fixture deliberately uses the invalid MBID `artist`; it is not a live failure.
Evidence: `oct07-artist-asset-final-app-first.log`,
`oct07-artist-asset-final-app-repeat.log`, `oct07-artist-sidecar-bytes-before.log`,
`oct07-artist-asset-final-bytes-repeat.log`, `oct07-artist-asset-repeat-ui.png`
and `oct07-artist-asset-final-native.log` in the existing release-audit directory.
The live deployment was reverified as healthy 2.21.0; downloads remain paused
with no active download/import workers. These fixes have not been deployed.

Live storage audit on the same healthy 2.21.0 deployment reports 94 GB under
/config/media-cover, 11 GB under /config/Backups and 13 MB under /config/logs.
A bounded filesystem-order sample of 2,000 cache files across 276 directories
contains 499 original images (161,019,945 logical bytes), 1,000 250/500 proxies
(43,966,926 bytes) and 501 small other files (134,054 bytes). One inspected
sample directory contains poster/fanart originals, their two proxies and source
manifests; this is not evidence of two different provider/canonical masters.
This biased sample is not a whole-cache breakdown or a cleanup authorization.
Audit original ownership/relocation, secondary artwork and backup retention
separately before removing anything. Evidence: oct07-live-mediacover-sample.log.

## October 7 witnessed cleanup candidate preview

Root inventory now records remaining unsupported/unowned paths during its
existing bounded traversal. There is no second filesystem scan just to build
the plan. LibraryCleanupCandidates is an operational table tied to its inventory
command; file-path paging uses its composite primary key. Each candidate retains
its root, exact filesystem witness and classification. Missing ownership for
supported media stops candidate collection rather than making that media junk.
Recognized unresolved metadata and sidecars of review media receive refused
classifications. Owned/review files and rewrite temporary names are excluded.

Only new checkpoints have cleanupPlanVersion 1. The public read-only endpoint
GET /api/v1/mediaFile/cleanup/preview requires a completed, configuration-current
whole-library inventory with unchanged root identities. It returns at most 100
entries using a stable path cursor. It checks current ownership/review claims
and file identity; changed, missing or out-of-root candidates are not eligible.
Legacy scans and incomplete scans cannot produce an apparently empty valid plan.
Restarting a fresh inventory clears its old candidates atomically with the first
checkpoint; command-history pruning cascades candidate rows, while independent
cleanup intents still survive as already designed.

The planner is a read-only preview, not a public deletion endpoint or an enabled
strict setting. A queued apply workflow still needs to consume the exact recorded
file witnesses, recheck applicability through the journal, persist per-path
outcomes, prune empty parents and expose refusals in the app. Explicit disposal
of remaining review media remains separate from default review protection.
Finish missing artist/secondary-art ownership and review-sidecar persistence
before enabling broad strict cleanup. Do not treat preview eligibility as a
blanket authorization to remove a later replacement at the same path.

Eight new active-schema checks cover the actual scan-created plan, legacy and
incomplete scans, current review/ownership and file witnesses, configuration
changes, protected review companions, stable cursor pages, command-history
cascade, wrong roots and HTTP selector validation. The focused journal/preview
file passes 20 tests. Rebuilt native Linux passes 53 of 54 journal/preview,
inventory and sidecar checks with one Windows-only casing test skipped.

Actual-app UI scans 6 and 7 completed on the rebuilt test container. The public
preview marked only /library/music/loose.json eligible, protected the unknown
FLAC's lyric and cover, and refused Loose/artist.nfo as unresolved. Known album
cover/lyric ownership and the unknown audio review row remained intact. The
repeat returned the identical four preview entries and eligibility decisions,
with identical SHA-256 values for every fixture file. Activity reported an
unchanged repeat. Evidence: oct07-cleanup-plan-app-preview.log,
oct07-cleanup-plan-app-repeat.log, oct07-cleanup-plan-bytes-before-repeat.log,
oct07-cleanup-plan-bytes-after-repeat.log, oct07-cleanup-plan-repeat-ui.png and
oct07-cleanup-plan-native.log in the release-audit directory.
Final full CI passed all 2,074 API and 187 frontend tests, lint, typechecks and builds, with no failing names or clone retries (oct07-cleanup-plan-ci.log). The live server was reverified as healthy 2.21.0;
this candidate has not been deployed and no live cleanup has run.

## October 7 queued cleanup application

The candidate now accepts POST /api/v1/mediaFile/cleanup/apply with a positive
inventoryCommandId and optional pruneEmptyFolders boolean, defaulting to false.
The route only queues CleanupLibrary; it does not remove files inline. The
exclusive disk command processes at most 25 candidates or five seconds before
continuing from its persisted path cursor. It consumes the exact file witness
recorded during inventory and checks the current worker lease, cancellation,
ownership, applicability, configuration and all library roots before mutation.

The cleanup journal commits the removal result and command cursor in the same
transaction. Failed commits restore the original bytes. A committed result
prevents a later replacement at that path from being deleted on retry. The
preview includes per-path outcomes and refusal errors, independently of current
eligibility. Applicable review media and review sidecars remain protected;
unresolved metadata is refused and makes the command fail visibly rather than
claiming a clean result. Explicit review disposal is still a separate workflow.

Optional empty-parent pruning uses recorded directory identities and checks the
remaining ancestor chain before each non-recursive rmdir. It stops at nonempty
directories, never removes a root, and records replacement/permission errors.
Pending pruning is retained with the committed file outcome for the same
command. A crash after rmdir but before its outcome transaction can undercount
folders already removed; retry treats missing parents as already absent. This
does not establish power-loss durability or protect against external processes
changing directories between the final identity check and rmdir.

Seven additional active-schema tests cover transactional rollback, replacement
protection, cancellation, root/review preservation, bounded continuation,
changed-directory refusal and the HTTP queue boundary. The final focused file
passes all 27 tests on Windows and native Linux. Final full CI passed all 2,081
API and 187 frontend tests, lint, typechecks and builds without failing names or
clone retries. Evidence: oct07-cleanup-apply-final-ci.log. The final native run
mounts only the rebuilt command, planner and test modules into the disposable
image to include the final checkpoint ordering and refusal diagnostics.

The isolated rebuilt app completed scan 6 and cleanup 7, removing two JSON files
and two empty parents while preserving unknown FLAC/lyric/cover bytes and the
known album's media/sidecars. It correctly failed on an unresolved artist NFO.
A second fixture scan 8 and cleanup 9 exposed a root-owned test folder as a
permission refusal, with zero removals. After correcting that disposable fixture
folder's permissions, cleanup 10 completed with one removal, two protected
sidecars and two empty parents removed. Both success and refusal appeared in
Activity. The NFO was moved to /tmp only to isolate this second test case; no
live files were touched. Evidence: oct07-cleanup-apply-refusal-ui.png,
oct07-cleanup-apply-success-ui.png, oct07-cleanup-apply-bytes-after.log,
oct07-cleanup-apply-final-focus.log and oct07-cleanup-apply-final-native.log in
the release-audit directory.

The live server remains healthy 2.21.0 with downloads paused and no active
commands. Its latest deep health check reports zero foreign-key violations.
The two previously identified catalogue/acquisition conflicts remain open.
This queued apply candidate is not deployed. Artist ownership without a
persisted membership path, secondary artwork, review-sidecar persistence and
app review controls remain gates before broad live cleanup, rename and retag.

## October 7 artwork roles and explicit artist folder identity

The Lidarr reference's XbmcMetadata consumer identifies artist folder/banner/
fanart/logo/landscape/clearart/clearlogo images and album cover/disc/discart/back/
spine images as MetadataFiles. These are distinct display roles, not additional
provider versions of the primary cover. The candidate recognizes those exact
secondary basenames with JPEG/PNG/WebP extensions. It registers confirmed
secondary images with file_type artwork and exact artist or edition ownership,
and retains their basenames when relocating them. Primary file_type cover keeps
its existing configured name and embedding/cache behavior. This does not create
new secondary images or allow arbitrary pictures to claim catalogue ownership.

An explicit known MusicBrainz artist ID in a top-level folder can establish
artist sidecar ownership without a LibraryArtists monitoring membership or saved
path. The library root and its configured media slot must still be unambiguous.
Unknown IDs, conflicting persisted identities and nested MBID folder guesses
remain unresolved. Plain-name artist directories without a saved path still
need stronger identity evidence. Recognized secondary art with unresolved scope
is refused by cleanup rather than treated as loose junk.

Three new active-schema tests cover explicit artist ownership without monitoring,
secondary-art registration and actual rename/repeat with stable basenames, and
unresolved secondary-art protection. The rebuilt native container passes 53 of
54 sidecar/cleanup tests with one Windows-only case skipped. Actual-app scans 6
and 7 registered five sidecars then reported an unchanged repeat, retained their
row IDs, created no monitoring memberships and preserved every fixture file's
SHA-256. The unresolved plain-folder fanart stayed in the refused preview.
Evidence: oct07-secondary-art-proof.log, oct07-secondary-art-before.log,
oct07-secondary-art-after.log and oct07-secondary-art-green-native.log.

Completed task, download-history and per-track download/import checks now share
the green Fluent success icon. Queued/cancelled states keep neutral glyphs.
The rebuilt Activity page visibly shows green checks; rendered completion icons
resolve to rgb(9,69,9) in the light theme. Evidence: oct07-green-completion-ui.png.
These changes are local candidates; the live app is still 2.21.0.
Final full CI passes all 2,084 API and 187 frontend tests, lint, typechecks and
builds with no failing names or clone retries (oct07-secondary-art-green-ci.log).

## October 7 revised artwork storage direction

Robert proposes making MediaCover exclusively a disposable proxy cache. Adopt
that direction for the next artwork redesign: no persistent full-resolution
master in MediaCover, including before an album has been acquired. Catalogue
refresh may fetch image bytes to derive the 250/500 display proxies, then discard
the full-resolution buffer. Download/import fetches the selected full-resolution
asset into its tracked library sidecar. Retag remains local-only and reads the
library asset to derive bounded embedded JPEG artwork. The selected source switch
still queues chunked library artwork replacement and embedded-art updates.

Artwork source identity, role, selected source revision/hash and exact library
MetadataFiles associations must be durable database state, independent of the
proxy directory. Existing source/sidecar marker files currently live inside
MediaCover; deleting that directory loses them even though library sidecars stay
on disk. Rebuild proxies from verified tracked library assets when possible,
otherwise from the configured source. Cache loss must never change the selected
source, substitute a low-resolution proxy as the library master or erase physical
sidecar ownership. Unsupported image containers need a tested conversion path
before the last cache master can be discarded.

Support Jellyfin-compatible role-specific library assets where sources provide
them, with an explicit bounded role policy and stable names. These are different
artwork roles, not retained canonical/provider alternatives for one primary
cover. Jellyfin's music documentation includes album backdrop/logo assets and
numbered backdrops; its ImageSaver uses cdart for music-album disc art. Extend
ownership/rename handling for those names and both album/artist roles before
generating them. Preserve recognized existing extras; automatic production of
multiple backgrounds is not an implicit requirement to fetch every available
image. See https://jellyfin.org/docs/general/server/media/music/.

The current implementation is not proxy-only. Its artwork refresh/match warmers
re-fetch missing cache entries and write originals plus derivatives. Browsing
uses local URLs and does not initiate a whole-cache rebuild. Recovery depends on
which entities are refreshed and whether their source is reachable; the entire
live 94 GB cache has not been wiped or subjected to a recovery acceptance test.
Before retiring old originals, verify a complete durable source/sidecar inventory,
proxy-only catalogue refresh, import materialization, cache-wipe recovery with
unchanged library hashes, source switching, rename and embedded-art regeneration.

## October 7 durable artwork state candidate

ArtworkSources now stores selected URL, preference, fulfillment kind and content
hash independently of MediaCover. ArtworkLibraryLinks stores album/edition master
associations by exact MetadataFiles ID, with provisional paths only during sidecar
registration. A file-row deletion cascades its link; renames resolve the row's
current path. The content hash is checked before accepting or rebuilding from
that original. Scope keys distinguish artists, albums, editions and videos.
Source writes use async writer admission after image fetch/processing; synchronous
sidecar registration uses the existing write mutex and short transactions. New
source and link records no longer write JSON manifests into the proxy directory.

An entity whose selected source is unchanged can regenerate missing 250/500 JPEG
proxies from its verified library master, without fetching or copying a master
back into MediaCover. Recovery preserves source preference and fulfillment kind.
Old JSON records remain bounded per-entity recovery inputs until a complete
legacy inventory/migration is implemented and validated. This is not yet a
permission to erase the old live cache. The fresh-download cache path still writes
originals; switching all import/backfill call sites to import-time full-resolution
fetching, artist/video/secondary master links and WebP/GIF conversion remains open.
Also validate competing artwork-source switches before broad live replacement.

Validation evidence in the temporary release audit directory:

- oct07-durable-art-ci.log: full CI passed, 2,084 API and 187 frontend tests,
  lint/typechecks/builds, no failing test names or clone retries.
- oct07-durable-art-final-focus.log and oct07-durable-art-final-native.log:
  all 62 focused artwork checks passed on Windows and Linux, including renamed
  masters, cache deletion/offline recovery, hash mismatch, source switches and
  deleted-row/cross-scope protection.
- oct07-durable-art-app-proof.log: existing schema-46 fixture accepted additive
  state tables; whole fixture MediaCover deletion recovered only two proxies.
- oct07-durable-art-runtime-proof.log: after actual-app retag command 6 completed,
  original cover SHA256 ffb61a110a3f6aca4103057afaf13a4f76bf1594c71153bb361bf2ba0a28dbfc
  remained unchanged, decoded FLAC audio matched its untouched control copy,
  canonical MusicBrainz tags/lyrics and a 1200x1200 embedded JPEG were present,
  and foreign-key violations were zero.
- oct07-durable-art-retag-ui.png: repeat tag preview says no files need retagging.

The live container was rechecked as healthy 2.21.0 at revision f4e46cbe83cc;
the candidate was not released or deployed, and no live cache/library mutation
was performed during this validation.

## Local Jellyfin and Lidarr artwork comparison

Rechecked both read-only references after Robert's reminder. Jellyfin's
MediaBrowser.Providers/Manager/ItemImageProvider.cs skips provider work when
enabled roles and limits are satisfied, fills missing singular roles, and treats
replacement as an explicit refresh operation. Multi-image roles have configured
limits and minimum widths. Adopt those decisions for bounded role fetching rather
than repeatedly downloading all remote artwork during ordinary scans.

Jellyfin's ImageSaver.cs chooses media-side or internal storage, retains role and
index, and uses folder for music primary art, cdart for album disc art, backdrop
for backgrounds, clearart/back/landscape and type-derived names for other roles.
It saves bytes before changing the item's image path and retiring the prior
asset, and reports its own filesystem changes to the library monitor. Adopt the
role/path association and own-mutation coordination principles. Keep our staged
atomic replacements; Jellyfin's direct FileMode.Create write is not a reason to
discard that protection. Its retry into internal storage on local write failure
must not silently recreate a full-resolution cache master under our proxy-only
policy. Report failed library artwork materialization explicitly.

Lidarr's MediaCoverService.cs checks remote headers against local presence,
length or modified date, fetches missing/changed album covers and derives display
sizes. Use its missing/stale refresh behavior, while preserving Discogenius's
selected source and verified library-original authority. The reference behavior
is source inspection, not proof that our pending import-time path already works.
## October 7 selected artwork materialization candidate

Import/organizer and missing-sidecar repair now use an explicit asynchronous
materializer. If the selected full-resolution asset is absent locally, it fetches
that recorded source into the library sidecar. Display proxies cannot substitute
for a master, including the local video-cover URL path. JPEG bytes are preserved;
PNG converts to JPEG at original dimensions where the sidecar requires JPEG.
Fetch bodies are bounded to 32 MiB and JPEG/PNG decoding to 48 megapixels.
WebP/GIF conversion remains unsupported and reports failure rather than writing
incorrectly named bytes.

Artist and video artwork now participate in exact MetadataFiles link tracking.
An unchanged verified local sidecar returns without rewriting artwork provenance;
empty-artist-folder picture repair skips an already present picture. Shared image
fetch/decode helpers live separately from the core cache service. Retag stays
local-only; missing-sidecar repair may fetch its already selected source.

Selected-source/configuration and destination witnesses are rechecked after fetch.
Staged replacement restores the previous bytes on a normal DB failure and keeps
its recovery copy if restoration fails. This is not a durable process-death
replacement journal. Finish that recovery boundary before broad source-switch
replacement or deployment of the new storage policy.

Validation: 105 focused checks pass on Windows and native Linux. A disposable
older-schema container materialized a 1200px JPEG after its cached master was
removed, with only 250/500 proxies remaining. Cache removal then retained the
selected source and exact library link. Actual-app retag completed with canonical
tags, lyrics and a 1200px embedded JPEG; decoded FLAC audio and original sidecar
hashes were unchanged, foreign-key violations were zero, and the second UI
preview reported no retag changes. No live cache deletion or deployment occurred.
Catalogue warmers still retain originals; global proxy-only behavior, complete
legacy-state migration and Jellyfin role ownership are pending.

Full candidate CI passes 2,088 API and 187 frontend tests, lint, typechecks and both builds, without failing names or clone retries.
## October 7 Jellyfin artwork ownership follow-up

Jellyfin ImageSaver.cs uses backdrop, backdrop1, backdrop2 and subsequent indexes
for backgrounds, cdart for music-album discs, and role basenames such as logo and
landscape. Inventory now recognizes those assets. Shared role names resolve first
against an exact artist-directory identity, otherwise against unambiguous physical
edition siblings. They retain their basename and exact MetadataFiles identity
through rename; unknown or conflicting scopes remain unresolved and Unmapped
companions remain protected. This recognizes existing files, not a policy to fetch
unlimited background variants. Generation/fetch limits and durable role selection
still require implementation.

The 83 inventory/cleanup checks pass on Windows; native Linux passes 82 with one
Windows-only skip and no failures. The candidate Docker image builds. The regression
covers artist/edition separation, numbered basenames through relocation, repeated
inventory, conflicting editions, and review companions.

Read-only live recheck confirms healthy 2.21.0, downloads paused, zero active
downloads/imports, and scheduled artist refreshes active. Recent failed refreshes
15767 (a-ha) and 15768 (Dirty Honey) reproduce known obsolete-track references in
ProviderTrackMatches/AcquisitionPlanTracks. Refresh 15766 (Cliff Richard) has the
same provider-match conflict for edition 5b198534-a6de-434a-a7ce-e5195311e45a and
track 098eebc2-4c39-435c-af68-91781fb35486. Add this to the reconciliation cases;
these are not fixed by deleting history or abandoning acquisition plans. No live
file mutations or deployment in this validation round.

Actual-app scan 8 linked seven Jellyfin-role fixtures with exact artist/edition ownership and unchanged image bytes, retaining the review album background. Repeat scan 9 kept row IDs and all image hashes, with zero foreign-key violations; Activity reported up to date, no file changes. The fixture's unrelated scheduled artist refresh fails because its deliberately non-UUID artist ID is not a MusicBrainz ID. Both disposable containers and their anonymous volumes were removed.

The first whole-suite role validation failed only planned shutdown drains a running work unit and refuses new admission. It reproduced alone: cold Windows tsx worker startup exceeded the test-only three-second drain deadline. The regression now completes a warm-up unit before testing active drain and rejected new admission. The isolated command lease suite passes after that change; production drain behavior/timeouts are unchanged. Final full CI is being rerun; the earlier failed run must not be reported as green.

An attempt to run the worker fixture suite in the production image fails because the test override always loads its tsx bootstrap and production intentionally omits that dev dependency. This is a test-environment mismatch, not proof of a production worker failure; use the builder stage with dev dependencies for that suite. The artwork/inventory native checks do run successfully in the production image.

The Linux builder-stage worker lease suite passes all 26 checks, including active drain, refused new admission, death recovery and capacity restoration. Windows isolated lease validation also passes all 26 after separating cold loader startup from the short active-drain assertion.

Final full CI after the worker test correction passes 2,089 API and 187 frontend tests, lint, typechecks and both builds with no failing names or clone retries. This supersedes the failed preliminary run; it is not live deployment acceptance.
## October 7 artwork container conversion candidate

Selected WebP/GIF artwork now converts through the bundled ffprobe/ffmpeg tools
into a full-dimension first frame for JPEG library materialization and display
proxies. Conversion is asynchronous, private temporary files are removed, tools
have timeouts/output limits and one decoding/encoding thread, input is capped at
32 MiB, and accepted dimensions at 48 megapixels. JPEG/PNG retain their existing
pure-JS path. A GIF library JPEG is intentionally a still first frame; this does
not generate animated album artwork or extra background assets.

Import now converts both remote origins and legacy local cached PNG/WebP/GIF when
the configured sidecar extension differs. The synchronous local copy helper
refuses container-extension mismatches; it no longer writes PNG bytes as cover.jpg.
Verified linked library masters take precedence over retained legacy cache masters,
and cached originals with a mismatched selected hash are rejected. Local source
and destination witnesses plus source/preference are rechecked before conversion
commit. Repeat verified JPEG materialization makes no provenance writes.

Corrupt WebP responses are rejected instead of being archived as unusable masters.
A prior test used only a PNG signature as its image and asserted those PNG bytes
were copied to a .jpg path; replaced that fixture with a real PNG and explicit
JPEG dimension verification. All 107 focused Windows/native-Linux checks pass,
including real WebP/GIF and source selection/failure recovery. Candidate Docker
build passes. Actual app retag of a real FLAC after local WebP conversion completed,
with canonical tags/lyrics and a 1200px JPEG, unchanged decoded audio and converted
sidecar SHA256, zero foreign-key violations, and no changes on repeat preview.
Cache removal rebuilt 250/500 proxies without a fetch. Disposable containers and
anonymous volumes were removed.

This resolves the unsupported-container materialization prerequisite, not the
whole cache lifecycle. Fresh catalogue warmers still persist originals. Complete
legacy-state/asset migration and crash recovery for source replacement, then switch
fresh cache writes to proxies-only and validate all callers before live storage
cleanup. The 94 GB live cache was not pruned; live 2.21.0 remains healthy with
downloads paused and no active download/import jobs.

Final conversion-candidate full CI passes all 2,091 API and 187 frontend tests, lint/typechecks/builds with no failing names or clone retries. Retag UI evidence and readonly in-container ffprobe/PCM/hash checks are retained under the local release audit directory.

## October 8 recording identity transfer candidate

Lidarr's RefreshTrackService transfers file associations for authoritative merges;
its RefreshEntityServiceBase distinguishes updated, merged and deleted entities.
Discogenius now applies authoritative recording redirects separately from mutable
track slots. The admitted edition transaction seeds canonical recording targets,
then transfers integer and MBID references before track position reconciliation.
The active-schema FK audit covers every recording owner, including provider
matches, credits, relations, video selections and file/library projections.

Media IDs, physical paths, file facts and sidecar associations survive. Selected
waiting acquisition plans retain their source assignments and get their canonical
choice keys refreshed. Only byte-for-byte equivalent credit facts consolidate;
conflicting credits, relations or selected owners roll back the savepoint.
Executing/claimed snapshots remain immutable. Standalone requests using either
recording MBIDs or integer IDs are protected through indexed checks, pending their
durable request-key reconciliation. Video artwork sources/links/recovery journals
also protect the old URL identity until a separate file relocation is implemented.

These are database identity changes, not physical tag or artwork mutations.
Affected file rows need subsequent rename/retag validation. The current service
does not yet replace owned obsolete track occurrences and cannot by itself fix
all three live refresh failures. Cliff has an authoritative recording redirect;
a-ha has the same recording on a changed occurrence; Dirty Honey has no verified
redirect. Do not infer all three as a merge or discard waiting acquisition intent.

All 48 focused Windows checks pass, including actual syncReleaseGroup ingestion,
unchanged repeat, active/claimed refusal, outer-transaction rollback, exact-credit
consolidation, selected video placement and source identity preservation. Final
whole-suite CI and current production-image tests remain pending. Preliminary
Docker/CI builds exposed an inferred fixture type missing OldRecordingIds; fixed
the fixture assignment and rebuilt successfully. This was a test compile error.

Readonly live API, NAS deployment proof and the actual Activity page still show
healthy 2.21.0, paused downloads, no active jobs and the same five failed history
events. The writer is currently free with no waiters; its cumulative maximum wait
has increased to 297265 ms, so contention is still an acceptance concern. No live
file mutations, deployment, queue clearing or cache removal occurred.

Current production-image checks pass all 48 focused cases without skips. The
actual fresh app completed a manually requested root scan, showed no active jobs
and rendered Completed with a green icon, verified as rgb(9,69,9) from the visible
SVG. This is startup/command/UI acceptance on an empty disposable library, not
whole-library recording or cleanup acceptance. The first fixture intentionally
had DISCOGENIUS_DISABLE_SCHEDULER=1, which also disables command execution; its
queued scan was discarded with that disposable container. Recreated with the
executor enabled and kept downloading/monitoring disabled. Screenshot capture
timed out; completion text and icon color were verified through the rendered DOM.

Final validation: full CI completed in 544.03 seconds with 2198 API and 187
frontend tests, lint, typechecks and both builds, with no failing names or clone
retries. A final audit added symmetric file-identity validation and exact soft-ID
to integer-FK transfer. After that change the entire API suite passes all 2199
checks without failures or retries; lint passes and the current production image
passes all 49 focused tests. The final CI build compiled the current source. No
release was tagged or deployed. Both disposable app containers and their
anonymous volumes were removed.

Robert has reiterated the weekend priority: complete live library repair and
strict cleanup, and materially reduce the config/MediaCover footprint before
resuming downloads. Finish owned track-occurrence reconciliation and the
proxy-only legacy artwork migration; preserve full-resolution library originals.
Do not treat local test completion as live acceptance or promise a perfect
library without checking its files, tags, artwork and repeat previews.
