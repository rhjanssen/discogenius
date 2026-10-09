# Discogenius task backlog

Outstanding work only. Shipped history belongs in `CHANGELOG.md`.

- October 9 artwork course change: MediaCover stores 250/500 proxies. New cache
  publication already does that. Full-resolution art is written beside the
  media by import and retag, from the selected source when the cache has no
  original. The edition-coverage retirement added in 833b207d is reverted.
  The ~92 GB of existing originals is a one-time delete after those sidecars
  exist: `api/scripts/drop-media-cover-originals.mjs`. It removes an original
  only when ArtworkLibraryLinks already points at a regular library file, and
  it leaves proxies alone. Do not run it on the live cache yet. Live is still
  2.21.0, downloads paused. CheckHealth 16281 completed; the stale worker
  cleared without a restart. Two RefreshArtist jobs run under the local
  MusicBrainz cap of 2, with the rest queued. No host SQLite connection.

- October9 scan candidate resolves artist MBIDs to integer ownership IDs in audio,
  video and path/sidecar matching. Reproduced duplicate/sidecar failures now pass;
  all56 Windows and55 native focused cases plus one OS-specific skip pass.
  Indexed folder-album selector preserves all311 Kinks rows, warm308-361ms to
  1.8-1.9ms, read once per title-candidate set. Actual app scan3 preserves both
  hashes, one TrackFiles owner1, exact duplicate link and no Unmapped rows.
  Final CI passes in376.53s:2250API, clone-file retries7/7 and21/21,187frontend,
  lint/types/both builds. No behavioral failures, deployment or live cleanup. Kinks16070 recovered
  and completed08:17:44 without intervention. Broader stale-worker cause remains.
  See MANAGED_LIBRARY_CLEANUP for limits and fixture failures.

- October 9 live liveness follow-up: old production2.21.0 command16070/The Kinks
  remains at907/1532, updated08:01:01; health503 reports stale busy worker while
  main writer is free and other tasks advance. No restart performed. Separately,
  ten real files on full-copy QA expose repeated folderAlbumIds title-selector
  reads of350-400ms twice/file. Native CPU/read profiling proves that cost,
  not the stalled live statement. Narrow indexed authoritative artist selection
  and avoid repeating identical reads per title; locate actual blocked operation.
  See MANAGED_LIBRARY_CLEANUP for evidence and limits.

- October 9 large JPEG decoding repair: the real 5333x3000 source reproduces
  jpeg-js's 256 MiB budget failure. Async artwork handling now falls back only
  for that JPEG allocation failure to native codec/dimension validation and
  bounded RGBA output. Existing 32 MiB input, 48 MP and native allocation limits
  remain; corrupt inputs do not gain a generic fallback. The actual image uses
  63,996,000 RGBA bytes, with 250/500 proxies of 37,281/108,894 bytes. Its source
  SHA256 is 06bb516ab3e3fa34a4f53abcab2fb15437a92588835fb5c83accc3f547eab47b.
  Two Windows regressions and all 75 focused production-image cases pass without
  skips. Actual isolated Settings cleanup command2 retires 2,253,900 cache bytes,
  preserving exact MetadataFiles owner1 and the full-resolution sidecar hash.
  Command1 failed because the seed created root-owned directories; fixture
  ownership was corrected to app UID1000. It is not a decoder regression.
  Actual native FLAC embedding gives 1200x675 JPEG, 230,799 bytes, unchanged PCM
  and unchanged full-resolution sidecar. No library-wide retag is claimed.
  Updated NAS full-copy QA image discogenius:large-jpeg-validation repeats all
  20 copied unimported origins: 20 retired, 0 protected, 26,021,596 logical bytes
  (QA-only command16044). Production cache was untouched. Retain the full NAS QA
  copy for further work; it is not production deployment. Final frozen-source
  CI passes lint/types and both builds in 355.52 seconds: 2,250 API cases after
  the known edition-monitoring-contract clone-file retry passes all 21 cases,
  plus 187 frontend tests (oct09-large-jpeg-final-ci.log). No active CI remains.
  Local app/container/volume and tab25 were removed. Remaining competing
  edition/manual and >50-linked-origin retirement gates still apply.
  Latest live check finds The Kinks RefreshArtist16070 stalled at scanning907/1532
  with an expired lease/stale worker heartbeat, while the main writer is free
  and another refresh completes. No exact blocking query is established yet;
  inspect scan work rather than restarting or attributing it to writer ownership.

- October 9 bounded legacy artwork admission: manifests larger than 50 tracked
  destinations previously aborted the entire first admission pass. The bounded
  512 KiB marker is now fully validated, with at most 50 destinations physically
  checked and committed per page. Exact committed links provide restart progress;
  the command keeps the same role until its remaining pages are admitted. Two
  regressions fail against the preceding production image and pass on the new
  candidate; all 22 focused Windows and 33 focused native cases pass. Actual
  isolated Settings cleanup admits 121 exact tracked owners, preserves every
  image hash, and completes command 1 with Activity reporting 0 originals removed.
  This proves admission paging, not retirement of an origin with over 50 links;
  that retirement guard remains and still needs durable bounded publication.
  Temporary local app/container/volume and tab24 were removed. Final frozen-source
  CI passes lint/types and both builds in 583.01 seconds: 2,248 API cases after
  the known edition-monitoring-contract clone-file retry passes all 21 cases,
  plus 187 frontend tests. No behavioral failures remain. Log:
  oct09-art-pages-final-ci.log; no active CI remains.

- October 9 real cache-policy sample: copied 20 unimported release-group origins
  and their source/proxy files from read-only live artwork into a separate writable
  directory in the NAS QA container. The actual retirement code and full copied
  database retire 19 copied originals (23,767,696 logical bytes), preserving source
  provenance and proxies. One valid 5333x3000 JPEG, only 2,253,900 compressed bytes,
  is protected because jpeg-js exceeds its 256 MiB decoding budget by 35 MiB.
  Fix this through bounded native image handling, not by raising memory limits or
  discarding the original. The live cache was not changed or reclaimed. QA proof
  is /config/cache-policy-proof with command16043 in the disposable copied DB;
  logs oct09-cache-policy-proof.log and oct09-cache-policy-sample.log. These 20
  filesystem-order samples do not establish whole-cache proportions or imported
  artwork acceptance. Keep source switching and competing edition/manual assets
  protected; do not claim all unused release-group retirement is solved.
  New live refresh failures16050-16052 repeat the same known Cliff/a-ha/Dirty Honey
  obsolete bindings on undeployed2.21.0. Monitoring has216 queued/2 running, fresh
  worker heartbeats and no current held writer/waiters; downloads remain paused.
  Do not mistake repeated old-version failures for regressions in the candidate.

- October 9 full-database preflight and waiting-progress repair: made a consistent
  online backup of the live 12,876,648,448-byte database through a separate
  readonly container connection. The candidate boots that existing ACTIVE schema
  on the NAS with scheduler/downloads/monitoring disabled and all live media and
  artwork mounts read-only. No production deployment or file mutation occurred.
  Actual app exposed a waiting request showing stale "Downloading track 6/15".
  Unclaimed queue projections now clear transient attempt text/rate/current-track
  fields and reset downloading/importing icons to queued, while retaining saved
  completion facts and the original durable payload. Claimed attempts retain live
  progress. Queue section is now labelled Download queue. Both focused Windows
  and native suites pass all 26 cases; actual full-copy app confirms the corrected
  waiting row. Final unchanged-source CI passes lint/types and both builds in
  336.59 seconds, 2,246 API cases after the known provider-registry clone-file
  failure passes all 3 cases on retry, plus 187 frontend tests. No behavioral
  failures remain (oct09-waiting-copy-final-ci.log).
  The full-copy first statistics response takes 3,132.7 ms, including HTTP 304.
  The reader already runs in a dedicated worker with stale-while-revalidate;
  this timing alone does not prove main-event-loop blocking. Profile cold reads,
  warm responses and concurrent health latency before changing architecture.
  NAS QA container discogenius-maintenance-qa and its disposable full database
  remain for this diagnosis; read-only library mount health warnings are expected.
  Production remains healthy 2.21.0, paused, with no active command backlog.
  Follow-up profiling of the actual reader on the full NAS copy measures the
  canonical aggregate at 3,505.9 ms cold / 1,570.49 ms repeated, file totals at
  60.44 / 59.28 ms. Twelve concurrent HTTP probes show cached stats 34.3-94.04 ms
  and health 30.04-96.87 ms. This confirms useful worker/cache isolation on this
  dataset; do not describe the cold response as a main-thread SQL stall. Logs:
  oct09-stats-profile.log and oct09-stats-http.log. Exact aggregate subquery
  costs remain unprofiled; optimize only if a measured workload requires it.

- October 9 real catalogue replay: exported a bounded FK-complete scope from the
  running live container through readonly better-sqlite3, then imported that
  540,057-byte snapshot into a disposable production-image ACTIVE-schema database.
  It contains the three failing editions, nine plans and three waiting requests.
  Composite foreign keys must be followed as tuples; the first scratch exporter
  incorrectly followed individual columns and failed serialization. It changed
  no live database/library state. The corrected exporter caps its scope at10,000
  rows and follows compound parent keys together.
  Current local MusicBrainz editions pass the actual production reconciliation
  method and acquisition planner: Dirty Honey8/8, a-ha33/33, Cliff Richard13/14
  available assignments. Exact incoming track/recording IDs and positions agree,
  foreign_key_check is clean, all three waiting request IDs/ref_keys/claims remain.
  Waiting admission selects the same requested providers: TIDAL/TIDAL/Deezer.
  Cliff's partial13-track offer must not be described as a complete14-track
  download; the unmatched occurrence still needs provider matching/acquisition.
  Logs: oct09-live-scope-final.log; replay script/snapshot remain outside the repo.
  This is a scoped native production-code replay, not a live refresh, full artist
  refresh, provider download or proof about owned-file collisions. The three known
  obsolete-track failures no longer reproduce in this scope with the candidate.
  Do not keep treating all three as unimplemented reconciliation. Broader legacy
  request ambiguity and owned collision handling remain. No deployment/deletion.

- October 9 canonical video artwork ownership candidate: reproduced two ACTIVE
  schema failures. Valid YouTube-only video art with a null recording MBID could
  not resolve its full master, while the same anchored sidecar could pass as an
  artist/album asset. Shared admission now uses exact MetadataFiles.track_file_id
  and TrackFiles.recording_id for video ownership, checks canonical scope fields
  and refuses audio/wrong anchors. Provider IDs never establish ownership. Legacy
  unanchored MBID video links retain their canonical admission. All31 focused
  Windows and production-image checks pass without skips. Actual isolated app
  keeps full800x600 sidecar/owner1 linked to canonical video1 with null MBID,
  retires13736 original bytes, keeps250 proxy and shows green completion. This
  tests artwork ownership and cleanup, not video decoding or provider downloads.
  QA tab22/container/volume removed. Final unchanged-code CI passes all 2,244 API and 187 frontend tests,
  lint/types and both builds in 336.85 seconds, with no first-TAP failures or
  clone retries (oct09-youtube-art-final-ci.log). Read-only live sample of
  20 YouTube-only recordings has no imported video files; it establishes no live
  affected-file count. Candidate remains undeployed and live cache untouched.

- October 9 prepared artwork recovery follow-up: reproduced an ordering bug where
  an old prepared retirement could publish new sidecar/proxy bytes before checking
  its saved source snapshot. Recovery now refuses changed publication provenance
  before any new image publication. All 28 focused Windows and production-image
  checks pass without skips. Actual isolated app seeds an old prepared intent and
  an unadmitted manual selection; a fresh cleanup preserves the exact small image,
  full original and MetadataFiles owner1, admits the manual source, protects the
  old intent and reports the competing asset honestly in Activity. This is a
  seeded stale-intent regression, not a new process-crash claim. QA tab21 and the
  disposable container/volume were removed. Final unchanged-code CI passes lint/types, both builds, 2,241 API
  cases after the known edition-monitoring-contract clone-file retry passes all21,
  and all187 frontend tests in340.37 seconds; no behavioral failure remains
  (oct09-cache-prepared-final-ci.log).
  Live scan16039 now completed at100%, no error: 0 removed, 0 added, 9 updated.
  Live health200, main writer no holder/waiters, downloads paused with no active
  downloads/imports, still image2.21.0. This old scan cannot authorize deletion
  because it lacks candidate filesystem witnesses. No live deployment or cleanup.

- October 9 legacy artwork admission candidate: cleanup now registers selected
  sources and physically verified legacy links in a bounded first pass across all
  families before replacing or retiring any originals. Exact row-ID renames and
  path-only links resolve through current MetadataFiles ownership; unknown paths
  cannot create owners. Old markers cannot overwrite current durable provenance,
  and unchanged records avoid repeat writes. Manual/non-fetchable selections are
  retained as provenance so competing art cannot replace them. All 26 focused
  Windows/native checks pass without skips; rebuilt production compose passes.
  Actual app: legacy-only 200x150 sidecar becomes selected 800x600 JPEG with exact
  owner1/hash, both proxies and 13,736 retired bytes; Activity shows green success.
  Another job admits a later-family edition selection before evaluating album
  art, preserves its image/owner and honestly reports the protected original.
  The manual local-upload variant likewise preserves the image and source record.
  Temporary app/volume/tabs19-20 removed. Initial CI passes 2,239 API and 187
  frontend tests in 373.11 seconds. Final unchanged-code CI passes all 2,239 API
  and 187 frontend tests, lint/types and both builds in 335.42 seconds, without
  first-TAP failing names or clone retries (oct09-cache-legacy-final-ci.log).
  No deployment or live cache deletion. Live scan16039 reached512/518 artists;
  a stale-worker HTTP503 remains intermittent, with main writer no holder/waiters.
  Remaining: authoritative unused-source retirement, large-destination paging,
  unmapped legacy source policy and remaining catalogue/library acceptance gates.
  Bounded live audit: 20 Album and 20 Edition folders all have canonical owners;
  19/20 sampled Video folders do. Source hashes exist in 19 Album and all sampled
  Edition/Video markers. This sample does not prove whole-cache admission; do not
  interpret the missing video owner as an inferred provider-to-recording mapping.

- October 9 selected-origin adoption candidate: cache cleanup now upgrades an
  explicitly linked lower-resolution library sidecar before retiring the verified
  selected original. It reuses the artwork mutation journal and exact tracked
  owner admission. External edits and another selected asset at the same path
  preserve both images. PNG-to-JPEG conversion keeps full dimensions and derives
  proxies from the converted, tracked master. All 12 focused Windows and native
  ACTIVE-schema checks pass; production compose builds and starts. Actual isolated
  app command1 replaces a 200x150 sidecar with the selected 800x600 JPEG, preserves
  MetadataFiles ID1/hash and both proxies, retires exactly 13,736 cache bytes and
  completes with a green Activity icon. QA container/volume/tab18 removed.
  Final unchanged-code CI passes lint/types, API tests, all 187 frontend tests
  and both builds in 344.62 seconds. Three known Node clone-transport file failures
  pass all 28/7/21 cases on the built-in isolation=none retries; no behavioral
  failures remain (oct09-cache-adoption-final-ci.log). No deployment or live cache removal.
  Remaining: safely adopt legacy manifest links, handle unused release-group art
  without replacing active edition art, and checkpoint large destination fanout.
  More than 50 destinations currently refuses before mutation. Secondary artist
  assets with explicit tracked links are proven; unlinked assets are not covered.

- October 9 recovery candidate (based on pushed 70472f29): a new
  cache cleanup replays older prepared retirements in bounded indexed batches;
  command-history deletion cannot cascade away unresolved evidence. Already
  missing origins settle accounting without overwriting a newer source selection;
  replaced physical origins still require fresh admission. Retirement follows
  the current MetadataFiles path for row-preserving renames. All 17 focused native
  checks pass in the rebuilt production image; Windows focused tests pass.
  Actual isolated app: injected post-unlink outcome failure leaves job1 failed and
  prepared evidence protected from history deletion. New job2 recovers job1's
  exact 13,736-byte outcome once and completes, with unchanged full JPEG/hash/owner
  and both proxies. Activity shows the honest historical failure and new success.
  QA container/volume/tab17 removed. Initial full CI passes 2,227 API and 187 frontend
  tests in 540.94 seconds. Final unchanged-code CI also passes all 2,227 API and 187
  frontend tests, lint/types and both builds in 429.25 seconds, with no first-TAP
  failing names or clone retries (oct09-cache-recovery-final-ci.log).
  Remaining migration gate: actually adopt selected full-resolution artwork for
  differing imported covers and sidecar-only/secondary assets; refusal is not
  migration completion. No live deletion/deployment or download resumption.

- October 9 work in progress: witnessed legacy-cache retirement now has durable
  prepared/outcome records, constant-time counters and bounded command units.
  Removed the old automatic origin unlink from local sidecar copying. Five new
  active-schema retirement checks and five ownership regressions pass on Windows
  and in the production image with the current compiled backend mounted read-only.
  Injected outcome failure after unlink retains prepared evidence and recovers
  accounting exactly once. Backend build passes. This candidate is not
  deployable yet: finish full-resolution adoption and remaining release gates.
  Repeated directory paging is now replaced by one streamed inventory per family
  and indexed pages. Fifteen focused native checks pass; restart, work continuation
  and changed membership are covered. A Linux test exposed identical timestamp
  witnesses within one clock tick; completion now verifies actual folder membership
  once as well. Thin endpoint and Settings button enqueue durable cleanup; Activity
  uses the correct label. Actual app command 2 removes the 13,736-byte test original,
  retaining both proxies and the exact full-resolution sidecar/hash/owner; completion
  is green. Command 1 correctly reported root-seeded fixture permission failure;
  fixing UID1000 ownership allowed the new job to complete. Initial full CI passed
  all 2,225 API and 187 frontend tests, lint/types and both builds in 542.88 seconds
  with no first-segment failing names. The final Linux membership correction landed
  during that run; final unchanged-code CI also passes all 2,225 API and 187 frontend
  tests, lint/types and both builds in 533.23 seconds, with no first-TAP failing names
  or retries (oct09-cache-retirement-final-ci.log). Temporary QA container/volume/tab16
  removed. Cross-command recovery/history retention is now covered by 10b3c99f
  above. Complete the remaining selected-origin adoption and legacy-link gates
  before live migration.
  Live is still 2.21.0, downloads paused. Root scan 16039 is at artist 470/518,
  file 1403/1468; repeated health probes return 503 for its stale busy worker,
  while the main SQLite writer has no holder or waiters. It then recovered to HTTP200
  and advanced to artist476/518, file658/1272 without intervention. CheckHealth16042 finished
  during observation. Investigate worker-local work rather than assuming a main
  writer lock or restarting the ongoing scan from an observation timeout.

- local candidate, October 8: full-resolution artwork master reads and tracked
  links now validate canonical ownership as well as file ID/hash. Same-byte
  transfers to another artist/album/edition/video cannot retain the old link;
  proper renames still work and stale legacy markers cannot adopt wrong owners.
  All 66 focused Windows/native checks pass without skips; actual app FLAC
  source switch preserves PCM and exact sidecar owner. No live deletion or
  deployment. Committed crash recovery now uses the same owner admission and
  preserves both versions on canonical transfer. Final full CI passes 2,215 API
  and 187 frontend tests, lint/types and both builds without failing names or
  clone retries; all 82 focused native checks pass without skips. Finish witnessed legacy-cache migration/retirement and source
  replacement for sidecar-only artists and secondary artwork roles.

- local candidate, October 8: artwork source changes now reconcile imported
  library owners once, removing the redundant whole-catalogue prewarm pass.
  All 13 focused Windows/native tests pass, including real FLAC source switching
  that never fetches an unrelated catalogue album. Actual isolated app completes
  command 3 with full-resolution selected sidecar/embedded cover, unchanged PCM
  and exact owner. Full CI passes 2,209 API and 187 frontend tests, lint/types
  and both builds without failing names or clone retries; production image and
  isolated app validation pass. No live deployment or cache retirement. Finish sidecar-only
  artist/secondary artwork source replacement and bounded legacy cache adoption
  and retirement; the measured 91.94 GB of cache originals is still present.

- local candidate, October 8: authoritative recording redirects now transfer
  all active-schema recording FK owners in a savepoint within the admitted
  edition write. Media/sidecar row identity and provider decisions survive;
  selected waiting plan keys follow canonical identity changes. Exact duplicate
  credits consolidate, conflicting owners roll back. Claimed/executing snapshots,
  standalone requests and artwork URL identities remain protected until their
  own reconciliation is complete. Both MBID and integer-only standalone lookups
  use verified partial indexes. All 49 focused Windows/native checks pass, including
  real catalogue ingestion and unchanged repeat. Full CI passes 2198 API and
  187 frontend tests; after the final symmetric file-identity check, the complete
  API suite passes 2199 with no failures, and lint/native build also pass. This is not a fix for every owned obsolete track occurrence or a
  deployed release. Finish those transfers and video-artwork relocation before
  retrying the three known live refresh conflicts. Live 2.21.0 is healthy/paused
  with no active jobs or held writer; cumulative maximum writer wait is 297265 ms,
  not evidence of a current stall.

- local candidate, October 8: the local MusicBrainz adapter now carries indexed
  authoritative old track/recording IDs, and catalogue ingestion validates the
  full redirect graph before writes. Full CI and all 187 frontend tests pass;
  the known inventory-sidecars clone error passes all 28 cases on isolation retry.
  All 23 focused native checks pass. The actual adapter exposes Cliff Richard's
  Shout recording redirect from the configured mirror. None of the three known
  failing track IDs has a track redirect; a-ha has a replaced occurrence of the
  same recording. Finish transactional owner transfers/collision handling and
  preserve waiting intent before live retries. Evidence plumbing alone does not
  resolve owned obsolete occurrences. Latest live scan remains 15759 on 2.21.0,
  downloads paused, no held/waiting writer.

- local candidate, October 8: spatial classification now requires fresh stream
  profile evidence. Full CI passes 2,176 API and 187 frontend tests, lint,
  typechecks and builds; 66 focused native checks pass without skips.
  Plain E-AC-3 surround cannot be accepted as Atmos, including
  when imported provenance names the exact variant. Native MP4/raw EC3 tests
  exposed incomplete tag-parser facts; unknown codecs now trigger FFprobe and
  outright parse failure falls back to stream probing. Scans retain the profile;
  import/organizer paths reject UNKNOWN instead of guessing from suffixes.
  Positive native Atmos recognition by the bundled probe remains unproven; no
  DOLBY_ATMOS-labelled live files were returned by the indexed sample. Resolve
  unidentifiable immersive delivery without a redownload loop before release.
  Live remains 2.21.0 paused; the same five historical failed refresh events
  remain, with no newer failed command in the bounded API inspection.

- local candidate, October 8: acquisition admission verifies existing audio outside
  the SQLite write gate before skipping tracks or retiring a request. It checks
  library containment, regular-file identity, probed codec/quality, canonical
  duration and the import/upgrade policy. Shared file admission stays held through
  the brief commit; the worker rechecks pause, import backpressure, exact request,
  selected offer and catalogue/profile snapshot. Missing or insufficient-quality
  files remain download candidates. Complete verified requests get completed
  history; partial offers cannot retire a whole-edition request, including when
  cached coverage is wrong. The ordinary command projection skips no unverified
  rows. This candidate is not deployed. Broader persisted-choice acceptance,
  recording redirects, legacy artwork migration and fresh witnessed inventory
  remain before the authorized live rename/retag/cleanup and queue resumption.
  Dashboard still calls its pending download section Active; include clearer
  queued/running wording in the remaining UI pass.
  Delivered stereo fidelity is now compared within a tier using the planning
  comparator and the same import conformity option. An unchanged measured
  delivery of the exact native variant is not rejected for being below a provider
  estimate. Source album variants now retain their member-track provenance.
  Final full CI passes 2,172 API and 187 frontend tests; 83 focused native checks
  and actual-app resume checks pass. Readonly reconstruction also passes 80 live
  plans in a bounded sample. This does not establish whole-library acceptance.
  Before release, validate declared spatial profiles/object audio, broader real
  imports and whole-library source graphs. Plain E-AC-3 surround must not become
  Atmos merely because of its codec; consult Jellyfin's probed Profile handling.

- local candidate, October 8: waiting acquisition admission distinguishes stale
  offers, unavailable offers, conflicting identities, disabled libraries, missing
  assignments/requested tracks and imported rows requiring file verification.
  Reasons persist without deleting intent or consuming a failure; unchanged
  reasons do not rewrite rows or create a self-kicking loop. Exact offer recovery
  clears the reason. Indexed library/edition/provider lookup also clears outdated
  reasons after plan regeneration, including when downloads are paused. Queue
  renders the explanation under the title; mobile 390px validation fits controls.
  All 58 focused native checks pass. Full CI passes 2,150 API and 187 frontend
  tests, lint, typechecks and builds with no failing names.
  Imported-row presence is not verified terminal
  completion; file existence, probed/imported quality and requested coverage must
  be validated before retiring those requests. Not deployed.

- local candidate, October 8: download admission no longer stops behind the first
  40 waiting rows. Indexed keyset pages retain blocked requests and release the
  write gate between worker turns. External queue changes restart from the head;
  internal continuations keep the cursor. Pause and import backpressure are
  checked before each continuation. Scheduling kicks coalesce. The production
  container passes 24 queue checks and both worker continuation/pause/front-insert
  checks. Actual app retains and displays all 82 fixture requests across pages.
  Full CI passes 2,148 API and 187 frontend tests, lint, typechecks and builds.
  Live remains 2.21.0, downloads paused. A readonly live
  reconstruction audit passes all five plans for editions 43824 and 32004 without
  duplicate resource keys or missing identities. This bounded sample does not
  establish whole-library acquisition acceptance. Explicit blocked/completed
  outcomes, broader legacy-choice acceptance, redirects and artwork remain.

- local candidate, October 8: provider refresh/rematch invalidates derived
  coverage while retaining plan/source headers and selected intent. Exact track
  match edges are upserted with stable IDs. Persisted plan keys now use canonical
  track/recording and provider resource/occurrence/variant identity, including
  the primary source, rather than replaceable match/member IDs. Intact existing
  choices are reconstructed from bindings before invalidation; waiting requests
  retain exact library, edition and provider before plan replacement. Missing
  manual offers remain unavailable; the same returning resource recovers even
  after member/match IDs change. Actual app verifies retained lock/selection,
  unavailable wording/disabled download and returning offer. All 62 focused
  production-container checks pass. Full CI passes 2,143 API and 187 frontend
  tests, lint, typechecks and builds with no failing names. Not deployed.
  Validate incomplete/conflicting persisted intent and larger live source graphs;
  explicit waiting outcomes/admission, canonical redirects and legacy artwork
  retirement still block release and queue resumption.

- local candidate, October 8: plan replacement, clearing, provider rematching
  and provider re-ingestion now share transaction-scoped ownership admission.
  Queued/running media commands and claimed waiting rows preserve their exact
  plan and source dependencies. Retry-safe metadata work yields its worker and
  retries after one minute without consuming failure attempts. Activity explains
  the wait and no longer appends queue positions. All 74 focused production
  container checks pass; the actual app shows the deferred refresh and completed
  history after owner release. Not deployed. The resource-identity candidate
  handles quiescent choice preservation; broader live lifecycle acceptance is
  still required. Final full CI passes 2,140 API and 187 frontend tests,
  lint, typechecks and builds with no failing names or clone retries. Final
  isolated fixture teardown checks also pass all 32 tests.

- local candidate, October 8: unowned removed edition occurrences expire derived
  acquisition coverage transactionally. Selected source keys, album locks,
  recording match decisions and waiting request identity survive; active media,
  claimed plans, standalone requests and file ownership fail closed. Production
  container passes 47 focused checks and the actual app shows the surviving
  track, retained lock and waiting request. Full CI passes 2,121 API and 187
  frontend tests with no failed names. Not deployed. Canonical recording
  redirects and owned occurrence reconciliation still need completion. The
  shared ownership guard covers the additional replacement paths, but durable
  choice preservation during quiescent provider changes remains unfinished.

- local candidate, October 8: waiting acquisition requests resolve regenerated
  plans by exact library, edition and provider. Removed the album-wide first-plan
  fallback and silent removal of unresolved requests. Partial-track requests fail
  closed if any requested track is missing. Production-container checks and app
  reload preserve the pending request. Full CI passes 2,115 API and 187 frontend
  tests with no failed names. Complete held-catalogue reconciliation,
  explicit blocked/completed request outcomes and admission past blocked queue
  windows remain necessary before downloads resume. This is not deployed.

- pending, October 8 live evidence: reconcile held catalogue tracks by explicit
  canonical changes, not slot substitution. Local MusicBrainz now lists 8 tracks
  for Dirty Honey's stored 14-track edition, with no redirect for the obsolete
  When I'm Gone recording. Cliff Richard's obsolete Shout recording redirects
  to Intro (Congratulations) / Shout; revalidate provider duration and medley
  coverage. Both sampled obsolete tracks have no TrackFiles, but held plans and
  accepted provider matches remain. Preserve selected/queued acquisition intent,
  update all proven owned dependants, and replan against refreshed metadata.
  Do not infer that every obsolete row is unowned from this bounded sample.

- locally validated, October 8: fetched/converted and local-only artwork writes
  use persisted replacement intent and atomic provenance acknowledgement.
  Startup/watchdog recovery rolls back uncommitted images, keeps committed ones,
  preserves external changes and blocks disk jobs with a visible Health error
  when ownership or bytes conflict. Real process-exit tests, 110 production-image
  checks and actual-app recovery/retag/repeat pass; full CI passes 2,109 API and
  187 frontend tests. Not deployed. Legacy cache migration/retirement,
  embed-without-sidecar acquisition and held obsolete catalogue-track
  reconciliation remain release prerequisites.

- locally validated, October 8: fresh artwork cache publications contain only
  250/500 JPEG proxies, or 250 for video. Durable derivative hashes detect missing
  and same-size corrupt files; intact refreshes do no work and late fetches cannot
  overwrite newer selections. Full CI passes 2,094 API and 187 frontend tests;
  production-image focused tests pass 118. Actual-app full-resolution sidecar
  import, cache-wipe repair and FLAC retag preserve audio and repeat without
  changes. Not deployed. Legacy source/link migration and witnessed retirement,
  and embed-without-sidecar acquisition still block release. Replacement recovery
  is covered by the later candidate above. Keep live downloads paused and do not wipe
  the live cache. See `MANAGED_LIBRARY_CLEANUP.md` for evidence and boundaries.

Status: pending | in progress | decided | revisit

**2.12.0** is the model-correct release: one artist identity, policy that is not unmonitor, albums still release groups in the UI, editions as coverage, catalog tables without `monitored` columns.

**3.0.0** is a later GitHub prune / initial commit with no history baggage. It is not this release.

## 2.12.0: artist identity (schema 46, shipped)

Production `createBaselineSchemaV41()` opens as `user_version` 46. Catalog artists are `ArtistMetadata`; membership is `LibraryArtists`. Unmonitor is `DELETE` that row. Policy (`all` / `new` / `none`) lives only on a kept row. `Artists` and `ManagedArtists` are gone.

Shipped:

- Catalog artists live in `ArtistMetadata`. No library row until you add them.
- Add writes `LibraryArtists` (`library_id`, `artist_metadata_id`). Path, origin, refresh ops, and policy live there.
- Unmonitor / leave this library is `DELETE` that row. Same as `LibraryAlbums` and `LibraryVideos`.
- `LibraryArtists.policy` on a kept row: `all`, `new`, `none` (pause). Pause is not unmonitor.
- Catalog `Albums` / `AlbumEditions` / `Tracks` / `Recordings` stay without `monitored` columns.
- `TrackFiles` use `library_id` + `artist_metadata_id`. Deleting membership does not cascade-delete files.
- Library artist list is `FROM LibraryArtists JOIN ArtistMetadata`. Catalog search does not invent membership. `ArtistStatistics` keys `(library_id, artist_metadata_id)`.

UI that the schema work does not finish:

- pending: artist card shows edition multiplicity when the library holds more than one; unmonitored card shows collapsed-twin count. Derive both. No new table.
- pending: album header names how many editions Download will queue. Switcher collapses equal digital twins.
- shipped: track rows offer download only. Monitoring and locking are album actions; no track endpoint changes every audio library.

## Manual validation (needs Robert)

- **Spatial audio:** turn Spatial audio ON if Atmos chips are missing on albums with matched Atmos offers, then confirm TIDAL + Apple Atmos on Bastille.
- **Apple Music:** Auth-page wrapper login, then one stereo/hi-res, one Atmos, one standalone video, one album-bundled video.
- **YouTube Music:** browser-header JSON + cookies; one authenticated audio and video download.
- **Deezer:** `arl` cookie; one Streamrip MP3/FLAC download.
- **Amazon Music / Spotify:** Auth shows **Soon**. No live validation until re-enabled.
- pending: video download → import → placement, any provider, end to end.
- pending: unmapped-file / manual import on a real root.
- pending: restart / idempotence of a completed download+import (must be a no-op).
- pending: confirm 2.6.11 embedded-MBID linking on a live root scan (`[DiskScan] Artist …: N files updated`).

## After 2.12, still open

- pending: medley / multi-recording video UX (one video of several tracks).
- pending: `COALESCE(canonical, provider)` sweep in read services, tag builder, organizer. Provider values are match-time only.
- pending: per-provider high-res artwork master (`getArtworkUrl({size: "max"})`).
- pending: SoundCloud permalink / Auth / diagnostics polish. DRM decrypt stays rejected.
- pending: provider plugin move. `api/src/providers` is a re-export; adapters still live under `services/providers/<id>/`. SoundCloud first if anything moves.
- pending: skip / lazily hydrate release groups excluded by type filters (Servarr-mode cost).
- pending: Housekeeping progress/cancel if large catalogs block user commands too long.
- pending: catalog mode-switch UX (optional "refresh monitored now"). Do not implement flush-on-switch.
- pending: import-list monitor modes (EntireArtist vs SpecificAlbum) and playlist **SYNC**. Decided, not implemented.
- pending: artist-wide coverage before edition pick (recording MBID → ISRC → shape). Per-edition set cover is already in `acquisition-plan-optimizer.ts`.
- pending: Docker image size vs `.ref_lidarr` / `.ref_jellyfin` packaging.
- pending: production service tests that still boot `domain-baseline.ts` move onto `active-schema-fixture.ts`.
- revisit: new-release detection cadence vs folding it into the 24h refresh.
- revisit: followed-artists-import vs Lidarr `ImportListSync` cadence.

## 3.0.0: later GitHub prune

Not 2.12.0. After the model is stable, replace the public history with a clean initial commit. No compatibility migrations, no dual writers, no leftover `Artists` / slot / `ProviderItemMatches` names in the tree. Until then, do not pretend the repo is already that commit.

### Runtime and file safety gates

The measured ownership problems and remaining acceptance gates are in
`RUNTIME_FOUNDATION_REVIEW.md`. Complete these before the 3.0 history prune:

- pending: atomic replacement for embedded metadata writes and journal coverage
  for new sidecar copies; test process crashes separately from power loss.
- pending: bounded MoveArtist and new-artist discovery; split very large artist
  reconciliation further if measured import waiting time requires it.
- pending: separate provider-edition matching preparation from persistence and
  move first-read ranking initialization into queued work.
- pending: representative mixed acquisition/import/retag/scan observation across
  enabled providers, including partial failures and exact file identity.
- pending: verify selected artwork source changes across originals, proxies,
  sidecars and embedded covers, then validate media-server presentation.
- pending: compare a typed dedicated writer with the bounded fair-mutex design
  on measured workloads before changing runtimes or database engines.

## UI and terminology pass after runtime stability

- pending: distinguish Running, Waiting, and Waiting to continue. Maintenance
  work can yield its slot without losing progress; a waiting row must not say
  it is currently processing. Remove the appended queue-position text.
- pending: use one status contract across Activity and Queue. Show durable
  completed/total counts, the current artist/album/file, and a percentage only
  when the total is known. Keep these updated through events plus reconciliation;
  show the last confirmed state when no fresh progress is available.
- pending: compare Jellyfin's scheduled-task progress and current-item display.
  Exercise rename, retag, scan, metadata refresh, download and import in both
  desktop and mobile layouts, including yielded work and restart recovery.
- pending: use Streaming services for media sources and provider-specific
  download tools. Explain artwork supplementation separately from canonical
  metadata, rather than describing everything as one provider.
- pending: name the two metadata modes clearly: MusicBrainz metadata through
  Servarr, and the local MusicBrainz database. Show the selected mode and mirror
  freshness. Detailed transport, matching and edition explanations belong in
  help popovers, while useful edition distinctions remain visible.
- pending: audit labels, icons, empty/error states, spacing and overflow menus
  throughout the app. Prefer concise actions and descriptions; keep operational
  detail available without putting implementation terminology in routine flows.

## Artwork storage and embedding acceptance

- in progress: restore the configured embedded-art resolution and impose a
  separate byte budget for JPEG derivatives across FLAC, MP3, M4A and Xiph.
  Preserve original sidecars. Verify decoded audio, tags and repeat comparisons.
- pending: reconcile remaining imported-cache masters with tracked library
  sidecars after rename, verifying exact content and ownership before removing
  duplicate originals. Ordinary scans must remain no-ops for unchanged files.
- decided: catalog browsing retains only 250/500 proxies. Selected full-quality
  artwork is fetched or migrated into a tracked library sidecar. Finish legacy
  source/link migration and validate source switching across all roles and embeds.
- pending: expose cache usage by originals, proxies, database and backups, and
  define retention for unimported artwork. Do not treat archival library covers
  as disposable cache files.

## Decisions worth keeping

- TypeScript stack. Do not port to .NET.
- Keep the `TrackFiles` table name (playable audio/video). Sidecars stay in their own tables.
- No multi-user / roles. Auth is the app/session gate.
- Three library roots by default (stereo, spatial, video). Spatial never fills stereo.
- Albums in the UI are release groups. Editions are coverage and folders.
- Schema 41 is the catalogue-model *name*. Production `createBaselineSchemaV41()` opens as `user_version` 46 (artist identity). There are no compatibility migrations. The CORE contract is `api/src/database/schema/domain-baseline.ts`; it is not what `initDatabase()` builds.

## Deprioritized

- Notifications, tags, blocklist/failed releases.
- Per-artist metadata or quality profiles (prefer library-type quality).
- Metadata-consumer profiles beyond MBID tagging and NFO/artwork sidecars.
- Flush SQLite catalog + live-query Postgres only (superseded by replicated-cache behavior).
- Dynamic npm plugin loading per provider.


## After 2.16.5 validation

- pending: merge remote catalogue discovery with local identities and show progress for queued hydration of unknown album/artist pages. Page opening must not monitor or download implicitly.
- pending: measure broad one/two-character search and cold track-list filters separately from selective album searches.
- pending: update persisted file size/mtime after standalone tag stripping, as retagging already does.
- pending: profile cold statistics reads and video-update transactions during concurrent catalogue refresh; the scale run still recorded 2.3 s and 6.5 s respectively.
- pending: reproduce artwork-cache temporary-file loss during concurrent metadata refresh.

## Live library readiness and conflict review

- pending: add a conflict-review workflow showing source and destination,
  canonical edition/track identities, current tracking ownership and technical
  quality. Preview a safe association correction or an explicit keep/replace
  choice; never hide an identity collision with an arbitrary suffix.
- pending: reverify the earlier audio rename conflicts from command 14723.
  Seven destinations are now owned by TrackFiles with matching track, edition
  and stereo quality. Recheck current ownership and physical duplicate witnesses,
  retain sidecar associations and repair the two stale edition tags through retag.
  Edition-MBID folders do not solve two files targeting the same track within the
  same edition. Historical unowned-destination observations are superseded.
- pending: reconcile the nonempty plain Bastille directory, whose music and
  artwork are not tracked under either its container or host path. Preserve
  unknown media until it has been matched or explicitly reviewed.
- pending: retry the 33 sidecars refused by the old rename plan through a fresh
  scoped preview; verify album/edition/recording/track ownership first.
- locally validated, October 6: rename and artist moves count actual removed
  empty parents. Pruning retains the root, refuses directory symlinks/junctions,
  recognizes Windows path casing and stops at nonempty parents. Not deployed.
- pending: after the artwork release, run an idempotent tag/artwork verification
  and update only mismatches. Keep Plex presentation acceptance separate from
  command completion and from folder naming.
- pending: make Check Upgrades clearly mean media quality acquisition. Scan
  Folders reconciles disk inventory and sidecars; it does not rewrite all tags
  or replace audio with a higher-quality provider download.

## Managed-library cleanup clarification

- requested, October 6: after inventory, identity, duplicate and sidecar handling
  are fixed and validated, run a fresh library-wide rename followed by retag,
  then strict unowned/duplicate cleanup and empty-parent pruning. Verify outcomes
  and no-change repeat previews. This is authorized follow-up work; incomplete
  inventory or a conflicting edition must be resolved before deletion.
- locally validated, October 6: sidecar deduplication checks scope and identical
  bytes, fixes the destination artist-field alias, verifies the staged source
  again and retains file witnesses through commit. Different lyrics/artwork and
  concurrently changed destination files are preserved; rollback keeps ownership.
  Native Linux tests passed 81 with one Windows-only case skipped. Final full CI
  passed after the known provider-registry clone flake passed its isolated retry;
  no new assertion failures. These fixes are on codex/managed-library-cleanup,
  not live 2.21.0.
- live validation, October 6: all eight failed catalog refreshes (15508-15515)
  completed on 2.21.0. Root scan 15506 completed with 187 additions, 61 updates,
  no removals and 26 new review files. Its root inventory checked 63,445 files
  across 3,802 directories with no missing roots. Activity shows completion and
  no active jobs; Unmapped shows 79 files, including grouped Bastille mixtapes.
  Downloads remain paused. A fresh audio
  audit of the eight earlier rename conflicts found seven equal decoded PCM
  pairs (32-bit decode hash; both sources 16-bit FLAC), two with differing
  edition tags, and one absent destination. All seven destinations are now
  TrackFiles rows 36044-36050 with the same canonical track, edition and stereo
  quality as their sources. Implement journaled consolidation preserving linked
  sidecars; retag must repair the two stale destination edition tags. Do not
  discard an edition solely because its decoded audio matches another edition.

- in progress: implement the inventory-before-deletion contract in MANAGED_LIBRARY_CLEANUP.md. Keep delete-untracked, delete-empty and remove-unmonitored policies separate.
- locally validated, October 7: root inventory links sidecars from exact physical/canonical ownership and repairs missing edition identity in existing rows while retaining IDs and rename/provider information. Ambiguous files/editions and conflicting canonical assignments remain protected; shared edition covers retain all confirmed library associations. Fixed library-ID-only inference that attached folder metadata to a sole track. Cleanup refuses unsettled recognized sidecars and protects APE/MP2/WebM/TS media. Sixteen active-schema sidecar tests pass; the broader checks pass 48 tests on Windows and 47 on native Linux with one Windows-only skip. Standalone catalogue and MBID-less YouTube video thumbnails retain exact physical ownership without invented edition or MBID context. The actual app repaired a real FLAC's existing cover/LRC rows, reported two sidecars linked, then completed an unchanged repeat with identical full-file hashes. Full CI passed 2,058 API and 187 frontend tests without failing names or clone retries. Not deployed. Finish artist-level ownership, review sidecar persistence/grouping, conflict diagnostics and bounded cleanup planning before live cleanup.
- locally validated, October 7: operational LibraryCleanupJournal stages unowned files without fake media ownership, rechecks complete current scan/configuration/all-root witnesses, protects review media by default, and recovers after process exit or command-history pruning. Pending intents block disk jobs and share startup/watchdog recovery and health reporting. Ten Windows cleanup tests and 34 native Linux cleanup/journal/scan tests pass. Not deployed; bounded planning, sidecar reconciliation and the public preview/apply workflow remain open, so strict deletion is not enabled.
- live, October 7: healthy 2.21.0, downloads paused, zero active jobs. Scan 15506 aged out of history; completed scan 15759 reports 62,973 files and no missing roots, but lacks candidate filesystem witnesses. New a-ha 15602 and Dirty Honey 15628 refresh failures involve obsolete catalogue tracks held by selected automatic TIDAL plans with waiting DownloadQueue rows. Preserve and replan their acquisition intent instead of deleting held bindings. No live cleanup performed; earlier eight successful retries remain successful.
- locally validated, October 7: fresh-container startup exposed synchronous monitoring follow-up writes throwing SQLITE_BUSY after successful commands. Command handoff now awaits async writer admission. The contention test verifies the terminal pass survives another writer and allows its release timer to run; a rebuilt fresh container completed all six startup/scan jobs without those errors. Fifty-one native cleanup/scan/monitoring tests pass. Not deployed, and this does not prove all live contention is resolved.
- validation, October 7: final full CI passed all 2,040 API and 187 frontend tests, lint, typechecks and builds with no failing names or clone retries. The existing serialization test now waits for an admitted owner instead of assuming cold-import resolution order. Candidate remains undeployed; complete strict planning and sidecar/artwork acceptance before the full live reconciliation.
- locally validated, October 6: same-edition stereo audio consolidation uses exact catalogue/library ownership, probed lossless quality and complete PCM hashes. Journaled deletion rechecks both file/row witnesses and transfers MetadataFiles/LyricFiles/ExtraFiles links atomically to the retained row. Different editions, spatial slots, inconsistent facts and changed targets remain protected. The rename preview exposes candidate verification while ordinary conflicts remain disabled. Fifty native rename/journal tests pass. Actual app rename retained the exact destination ID and moved a real lyric, then retag wrote canonical fixture tags and lyrics with unchanged decoded audio; repeat rename/retag previews had no changes. Not deployed. Finish strict cleanup and artwork acceptance before the full live reconciliation.
- authorized final reconciliation: after identification and validated complete inventory, explicitly dispose of remaining Unmapped media as requested by the active goal, separately from default review-preserving strict cleanup. Verify all surviving files have catalogue/sidecar ownership, then complete library-wide rename/retag acceptance before clearing and resuming downloads.
- locally validated: routine scans include unambiguously identified plain-name artist siblings and register unmatched media for review.
- live 2.21.0: resumable whole-root inventory registers loose and unknown-folder media, preserves ignored review entries, and uses indexed ownership checks. Orphan pruning preserves records when their root is unavailable.
- locally validated, October 6: root inventory rejects disappeared subdirectories and replacement roots/current directories, persists filesystem identity across continuations, and checks containment and ancestor links before reading empty directories. Roots absent at scan start remain marked missing if they reappear. Ten active-schema checks passed on Windows and native Linux; final full CI passed with no new failing names and the known provider-registry clone failure passing its isolated retry. The rebuilt app registered real stereo FLACs and a repeat preserved review row IDs with no additions. Legacy checkpoints lack this new identity evidence; an empty failed mount still needs a separate health gate. Candidate is not deployed.
- locally validated, October 6: manual Scan Library Files and scheduled RescanFolders now share artist reconciliation and root inventory. New-artist discovery is a persisted phase, not a separate handler path; inventory continuations do not repeat it. The rebuilt app registered three real FLACs for review, including loose root media and disabled spatial-library media, and a repeat preserved row IDs with no additions. Both manual runs persisted complete root inventories and discovery counts. Empty roots preserve missing owned/review records, and admitted writer transactions recheck missing files before removing ownership. Forty-one native Linux tests cover these scan phases and safety checks. This candidate is not deployed; discovery still needs bounded work units, and a completed scan alone does not authorize strict deletion.
- pending: automatic canonical identification of media in unknown folders, grouped unmapped album review, exact sidecar ownership and bounded journaled strict cleanup before enabling that policy. An empty mount point must not count as a healthy root.
- pending: after Discogenius reconciliation, snapshot Lidarr and test read-only rescans on Bastille/Bakermat before library-wide edition reassignment.
- pending: audit scan counter accuracy and repeat work. Live command 15214 completed all 518 artists on October 4 at 20:45 UTC (592 indexed, 21,048 updated, none removed). Scheduled follow-up 15496 already reports 9 indexed and 35 updated after 3 artists. Duplicate-extra re-evaluation increments indexed even when an existing row is upserted; distinguish new owned files from reclassification, and verify why file facts change on the repeat before declaring the scan idempotent. The mutation journal is empty and downloads remain paused.
- locally validated: duplicate rescans preserve the ownership row through inspection, count only its first registration, and transactionally replace it on promotion. Audio-fact backfill uses the shared writer gate and counts only changed facts. Active-schema tests cover stable duplicate IDs, failed-promotion rollback and writer contention. A native ffmpeg/real-file full-handler repeat produced no changes and preserved decoded audio; Activity displayed the no-change result and Unmapped retained unknown FLACs. Full CI passed after an edition-monitoring test-runner clone flake passed its isolated retry. Linux container validation subsequently passed in the October 5 scheduling candidate. Not deployed. This does not yet eliminate probing for files whose quality remains unknown.
- locally validated: daily root scans wait one full configured interval after successful whole-library completion. The completion timestamp is persisted atomically with the command and survives history cleanup. Scoped artist scans, failed commands and stale worker claims do not satisfy this schedule. Targeted active-schema and Linux tests passed; system/task reports the same completion-based next execution. Full CI passed 1,975 backend and 186 frontend tests. Not deployed. Other scheduled tasks still use their existing queue-based intervals.

- locally validated: canonical tag-link backfill now obtains writer admission, resolves the catalog inside that admitted unit, and updates only the same still-unlinked file row. A competing rename, track assignment or conflicting edition leaves the row untouched and does not count as healed. Four real tagged-FLAC regressions pass on Windows and Linux. Removed the retired duplicate-ownership release helper and its obsolete tests; atomic promotion coverage remains. Full CI passed 1,977 backend and 186 frontend tests. Not deployed.
- locally validated: the shared catalog-detail writer reconciles by stable track MBID, preserving integer identity through position changes and cross-edition moves. Connected editions commit together; unrelated editions release admission separately. Exact membership checks repair incomplete or surplus unreferenced rows even with an unchanged content hash. Incomplete track lists and obsolete identities referenced by files, matches or plans fail explicitly. Active-schema tests cover swaps, source-order independence, rollback, file references and no-change repeats. A native replay of 280 incoming tracks and 11 captured Ray Charles/Yes identity conflicts preserved a real FLAC's row reference and decoded audio, with zero repeat writes. This replay does not cover all live obsolete plan references. Not deployed.
- locally validated: command/pipeline artist statistics compute outside writer admission and persist current projections in bounded batches. Contention tests cover changed inputs, artist deletion and fairness between batches. Five scoped native checks on the local 11 GB production clone took 53-248 ms without write holds above the 10 ms logging threshold; these uncontended checks do not prove whole-library contention is resolved. ApplyCuration now retains per-artist failures and fails the command instead of reporting successful completion with errors. The local Activity UI showed both successful and deliberately failed outcomes. Live command 15502's 13 errors were database locks, separate from the eight catalog-identity failures. Not deployed.
- locally validated: removed catalog tracks release only unused acquisition candidates, transactionally with edition reconciliation. Library selections, DownloadQueue holders and queued/active command plan references prevent removal. Indexed holder lookups avoid scanning the download backlog. Captured live Yes references comprised three unused plans and 14 assignments; replaying all eight failed groups with those actual references reconciled 1,808 incoming tracks and 37 position/edition conflicts, preserved surviving integer IDs and decoded test audio, had zero foreign-key violations and made zero repeat writes. The local UI queued curation for all eight artists; the command executor completed all eight and Activity showed successful history with no active jobs. Eight active-schema safety/index tests and 31 catalog-writer tests pass on Windows and Linux. Full CI passed 2,000 backend and 186 frontend tests. Not deployed.
- pending: expose a clear review/replan action for catalog changes blocked by a selected, queued or active acquisition plan. Preserve the standing manual choice and imported file identities; do not silently substitute a provider or delete held assignments. Complete live foundation/library acceptance before resuming downloads or strict cleanup. Bounded failed-refresh retries are part of controlled deployment validation.
- validation, October 5: full CI passed after a provider-registry clone-deserialization failure passed its isolated retry. Final focused catalog/statistics/curation tests passed all 37 on Windows and native Linux; the candidate Docker image builds. The latest persisted live deep-health result is healthy with zero foreign-key violations, and downloads remain paused. These are local candidate checks and read-only live inspection, not deployment acceptance.
- locally validated, October 6: async statistics use smaller event-loop batches and indexed integer/MBID artist scopes. On the 11 GB, 518-artist clone, a warm competing-writer comparison reduced maximum event-loop delay from 412 ms to 55 ms with identical result digests. During 17 full refreshes, 850 mixed HTTP requests succeeded with p95 47-52 ms. Initial cold baseline delay reached 3.1 s; these warm comparisons do not establish cold NAS performance. Twenty-four broader statistics/curation/query tests pass on Windows and native Linux, including persisted restart truth. Prepare 2.21.0 for controlled live validation with downloads paused; unresolved library conflicts are not permission to overwrite media or resume acquisition.
- deployed, October 6: 2.21.0 is healthy on TrueNAS, verified by actual image digest/revision and both package versions after a stopped-app ZFS snapshot. Full local/release CI passed (2,001 API, 186 frontend). Downloads remain paused; scan 15506 resumed its checkpoint. Ray Charles retry 15508 completed; seven remaining failed artists were requeued for bounded validation. Bastille's live rename preview reports zero changes. Still investigate the observed 1.834-second provider-ingestion writer hold, 2.58-second cold dashboard statistics request, non-monotonic provider progress and root scan's prolonged unchanged file progress. Config remains 108 GB, primarily 93 GB artwork and 11 GB backups; artwork/storage acceptance remains open.
- locally validated, October 7: exact persisted LibraryArtists directories now own artist pictures/NFO without arbitrary track/edition links, with indexed lookups, shared-library scope and writer rechecks. Actual-app testing reproduced unsafe scan-time deletion of an artist picture grouped with an incomplete album cover. Removed the stale-sidecar/audio-presence deletion heuristic; automatic deduplication now merges only aliases of the same resolved path and preserves distinct physical assets for verified cleanup. Twenty-four inventory tests and 62 combined Windows checks pass; native Linux passes 92 of 94 broader checks with two Windows-only skips. The rebuilt app preserved three correct metadata rows and unchanged JPEG/NFO bytes through scan 9 and unchanged repeat 10. Full CI passed 2,066 API and 187 frontend tests, lint, typechecks and builds with no failing names or clone retries. The adjusted stale-lyric lifecycle test also passes all nine backfill tests on Windows and native Linux. Candidate remains undeployed; strict planner, review-sidecar disposition and ownership without a persisted artist membership path remain open.
- live storage, October 7: config media-cover is 94 GB, backups 11 GB and logs 13 MB. A bounded 2,000-file sample contains 499 full-resolution images and 1,000 proxies; one sampled directory holds poster and fanart originals, not proven provider/canonical duplicates. Whole-cache ownership/relocation and backup retention still need validation. No storage pruning performed.
- locally validated, October 7: root inventory collects witnessed cleanup candidates in its existing bounded walk; indexed preview pages require a new completed/configuration-current/all-root-witnessed inventory and recheck current ownership and file identity. Protected review sidecars and unresolved metadata are reported at exact paths. Eight new active-schema checks pass; native Linux passes 53 of 54 broader tests with one Windows-only skip. Actual app scans 6/7 produced the same four-entry preview, with only loose JSON eligible and all file bytes unchanged. Full CI passed 2,074 API and 187 frontend tests, lint, typechecks and builds without failing names or clone retries. Public queued apply, persisted outcomes/empty-parent pruning and app review controls remain open; no live cleanup or deployment.
- locally validated, October 7: public cleanup apply queues an exclusive bounded disk command using exact inventory witnesses. Removal outcomes and cursor commit together; failed commits restore bytes, replacements survive retry, review companions remain protected, and witnessed empty-parent pruning retains roots. Preview exposes per-path refusal diagnostics. All 27 focused tests pass on Windows/native Linux; final full CI passes 2,081 API and 187 frontend tests without failing names or clone retries. Actual-app Activity showed both unresolved/permission refusals and a successful retry, with unchanged known/review media and sidecars. No live cleanup or deployment. Finish ownership without artist membership paths, secondary artwork, persistent review sidecars and app review controls before broad live cleanup. Directory counts can underreport a crash between rmdir and outcome persistence; see MANAGED_LIBRARY_CLEANUP.md.
- locally validated, October 7: Lidarr-style secondary artwork basenames now have artist/edition ownership with a distinct artwork file type and stable filenames through relocation. An explicit known top-level artist MBID can own sidecars without monitoring membership or a saved path; unknown/conflicting/nested IDs remain unresolved. Actual-app scans registered five sidecars and an unchanged repeat preserved IDs and all file hashes. Unresolved plain-folder fanart remains refused, not junk. Restored green completed task/download/import checks through the shared Fluent status icon and verified the rendered Activity page. Final full CI passes 2,084 API and 187 frontend tests; native sidecar/cleanup validation passes 53 of 54 tests with one Windows-only skip. Not deployed. Plain-name artist identity, persistent review sidecars, artwork cache relocation/size and app cleanup review controls remain open.
- decided, October 7: move toward exclusively disposable 250/500 MediaCover proxies, with full-resolution role-specific assets fetched into tracked library sidecars during download/import. Durable source/revision/sidecar links belong in the DB, not disposable cache markers. Keep retag local-only and source changes as chunked library replacement/embedding work. Add Jellyfin album/artist backdrop/logo/cdart ownership and stable naming before producing those assets. Pending implementation and cache-wipe/source-switch/import acceptance; the live cache has not been erased. Full design and recovery boundaries are in MANAGED_LIBRARY_CLEANUP.md.
- locally validated, October 7: artwork source provenance and exact album/edition sidecar links now persist in additive operational DB tables. Removing a fixture cache after an album-folder rename preserves the selected source and full-resolution sidecar; recovery rebuilds only 250/500 proxies without fetching or duplicating its master. Hash mismatches and deleted MetadataFiles rows fail closed. Actual app startup on an older active-schema fixture, image serving and UI retag passed; decoded audio and original cover hashes stayed unchanged, canonical tags/lyrics and a 1200px embedded JPEG were verified, and repeat preview reported no retag changes. Full CI passes 2,084 API and 187 frontend tests; final Windows/Linux focused artwork checks both pass all 62. Candidate not deployed. Fresh catalogue downloads still retain masters pending import-time materialization; complete legacy-record migration, all artwork roles, unsupported-container conversion and source-switch concurrency acceptance remain open. Do not wipe live MediaCover yet.
- locally validated, October 7: selected full-resolution artwork can be fetched explicitly into library sidecars at import/missing-sidecar repair without promoting 250/500 proxies. Artist/video links use exact MetadataFiles identity; verified unchanged sidecars avoid repeat provenance writes. Focused Windows/Linux checks pass 105 each and actual-app FLAC retag preserves decoded audio and master bytes, embeds canonical tags/lyrics/1200px JPEG and reports no changes on repeat. Catalogue warmers remain unchanged; process-death replacement recovery, unsupported codecs, legacy migration and Jellyfin role ownership still block the proxy-only storage policy. No deployment or live cleanup.
- locally validated, October 7: Jellyfin backdrop/backdropN/cdart and shared logo/landscape roles are recognized by strict inventory using exact artist or unambiguous edition ownership. Numbered basenames survive relocation; unresolved and Unmapped companions stay protected. Windows inventory/cleanup passes 83; Linux passes 82 with one Windows-only skip. Role generation remains pending. Read-only live refresh 15766 adds Cliff Richard to the obsolete ProviderTrackMatches reconciliation cases alongside a-ha/Dirty Honey. Downloads remain paused on healthy 2.21.0.
- validation, October 7: final Jellyfin-role full CI passes 2,089 API and 187 frontend tests plus lint/typechecks/builds. Actual-app scan and repeat preserve seven correctly owned Jellyfin-role files and their IDs/bytes; repeat reports no changes. Worker drain test now warms the TypeScript loader before its short deadline; all 26 lease checks pass Windows/Linux builder stage. Production shutdown behavior is unchanged. Still not deployed.
- locally validated, October 7: real WebP/GIF selected origins now decode through bounded asynchronous native tools for full-dimension JPEG sidecars and display proxies. Legacy PNG-to-JPEG copying now converts actual bytes; sync copying refuses format mismatches. Verified library masters precede legacy cache originals and repeats avoid provenance writes. All 107 focused tests pass Windows/Linux; actual-app FLAC retag preserves decoded audio and converted master, embeds canonical tags/lyrics/1200px JPEG, and repeats without changes. Fresh cache writes, legacy migration and process-death source-replacement recovery still need completion; no deployment or live cache deletion.
- validation, October 7: final artwork-container conversion CI passes all 2,091 API and 187 frontend tests, lint, typechecks and builds without failing names or clone retries. Focused native validation passes all 107. No release/deployment yet; continue full proxy-only lifecycle and live cleanup prerequisites.

- locally validated, October 8: track occurrence replacements preserve exact local
  owners for authoritative aliases or a unique unchanged recording within the same
  edition. Recording redirects precede this step; waiting plan keys also survive
  a preceding stale-state transition. Conflicting owners and active snapshots
  roll back. All 55 focused Windows/native tests and full CI pass, including 2205
  API and 187 frontend tests. The actual isolated dashboard scan completes. The
  readonly live graph qualifies a-ha; Dirty Honey has no replacement recording,
  and Cliff has an existing target with two old occurrences. Broader consolidation
  and legacy intent remain acceptance gates. Live stays 2.21.0 with downloads
  paused, scan 16039 progressing and no current writer holder/waiters. Finish
  proxy-only legacy cache migration and live library acceptance before resuming.

- in validation, October 8: replace correlated artist-folder provider scope checks
  with indexed ID sets. Exact readonly live results agree for Midnight Oil;
  release selection falls from 331 ms to 4.7 ms and broad member selection from
  5702 ms to 6.2 ms. Focused Windows/native checks pass 38/42; full CI pending.
  Live root scan 16039 advanced to 318/518. Unchanged duplicate extras still need
  file-fact filtering in Known scans. Current artwork warmers already publish
  proxies only; finish legacy source/sidecar migration and witnessed retirement
  instead of repeating proxy generation. No deployment or live cleanup performed.

- validated, October 8: final scan-scope CI passes 2207 API/187 frontend checks,
  lint, types and builds in 552 seconds without failing names or clone retries;
  all 42 native focused tests pass. Legacy artwork sample has 18 cache originals
  beside 20 tracked existing covers, with only four identical copies. Explicit
  ConfigPrune artwork preference switches currently use missing-only scan repair,
  leaving existing sidecars/embedded art unchanged; fix that workflow before
  artwork migration and cache retirement. Do not erase differing origins blindly.

- validated, October 8: explicit artwork preference jobs replace existing covers
  and update embedded art; scan repair remains missing-only and retag local-only.
  A real FLAC regression proves master dimensions, exact metadata ownership,
  unchanged decoded audio and idempotent repeat. All 13 Windows/64 native focused
  checks and full CI pass (2209 API, 187 frontend). Actual Settings source switch
  completed with verified sidecar and embedded art after correcting test fixture
  permissions. Activity's artwork job label/description still needs correction.
  Candidate not deployed; legacy artwork migration/retirement remains open.

- in validation, October 8: Activity preserves ConfigPrune's artwork intent in
  the API projection, labels it Update Library Artwork and displays its actual
  progress/result. The real app exposed the missing flag before the fix, then
  showed the correct title with success/failure outcomes afterward. Completed
  SVGs use Fluent's green success token. The new native history regression passes
  2/2; standalone frontend tests pass all 187, typecheck/build and root lint pass.
  Full CI is running. Screenshot capture timed out, so visual screenshot QA is
  not claimed. The app-directory lint command separately lacks jsx-a11y plugin
  rules already present in the root lint configuration; use required root CI.
- live cache audit, October 8: logical origin files total about 91.94 GB versus
  8.68 GB proxies, primarily 76.09 GB Album origins. No files were deleted. Finish
  bounded legacy source adoption and witnessed retirement, including unimported
  catalog cache origins, while preserving imported full-resolution sidecars.
- packaging gate: actual ffprobe 5.1.9 lacks the Atmos profile declarations
  present in FFmpeg 6.1. Validate a supported runtime upgrade and positive real
  JOC probing; rejection-only tests cannot make this gate pass. Official old
  Dolby test download links now return 404. Scan 16039 reached 340/518; transient
  stale-worker health recovered without intervention, downloads remain paused.

- validated, October 8: final artwork Activity candidate CI passes all 2210 API
  and 187 frontend tests, lint/types/both builds in 556 seconds without failing
  names or clone retries. Native history regression and actual app verify intent,
  title, details and green completion icons. No NAS deployment/cleanup performed.

- validated, October 8: Debian Trixie runtime fixes the Atmos profile packaging
  mismatch. The official Dolby JOC fixture fails positive admission on old
  FFprobe 5.1 and passes exact ACTIVE-schema TrackFile admission on FFprobe7.1.5.
  Actual tag/cover writes preserve the encoded JOC audio hash and acceptance.
  All 117 native checks pass without skips; isolated compose build/start and
  actual artwork source switch pass. Source CI from f53841e7 remains applicable
  to unchanged TS. Still undeployed. Positive DD+ JOC recognition is now proven;
  broader variants, cache retirement/plan reconciliation/live acceptance remain.
