# 2.16.10 validation

Compared with release 2.16.9. Production remained on 2.16.9 during this work;
the fixes were exercised in local Docker containers and on a copied catalog.

## Findings and scope

Production reported a longest SQLite writer hold of 667 seconds during
YouTube catalog ingestion. Repeated video candidate queries were expensive,
and several auxiliary writes bypassed asynchronous writer admission. The
patch batches candidate offers, restores indexed provider-ID lookups and
routes the observed identity, artwork, lyric, history and refresh writes
through the existing write gate. Network requests stay outside those gates.

Lidarr marks retagging and importing as disk-access commands. Its queue does
serialize those operations. Removing that exclusion would not address the
observed database contention and would permit overlapping file mutations.

An Apple Music import had ISRC USUM70809583. The canonical recording already
contained both USUM70722793 and USUM70809583, but our tag query selected only
the first. This case was a tag-selection bug, not evidence of a wrong match.
The patch writes all canonical ISRCs and uses Picard's native representations.
It also places MP3 recording IDs in MusicBrainz UFID frames. Provider ISRCs
remain separate matching evidence, with a tag fallback when the canonical
list is empty.

## Checks performed

The September 14 full `yarn ci` rerun passed lint, type checking, all 1,843 API
and 181 frontend tests, and both production builds in 461.62 seconds.
After Docker Desktop recovered, the final image rebuilt successfully. A new
container with empty tmpfs directories created schema 46, passed SQLite
integrity checks and completed startup commands. The packaged version is 2.16.10.

The final image retagged all 36 files in the preserved Bastille test library
with zero missing files and zero errors. The next preview was empty. Settings
and the real Bad Blood page loaded at 1440 and 390 pixels without page errors
or horizontal overflow; screenshots were visually inspected. Both parked-import
browser regressions passed against the final image.

The latest production status was reachable and had two active commands with
current heartbeats, no expired leases and an empty writer queue at that instant.
Eligible queued work was still roughly five days old. This snapshot does not
prove sustained throughput or validate the candidate on the live server.

Earlier candidate checks are retained below for context:
- Full `yarn ci`: lint, type checking, 1,842 API tests, 181 frontend tests and
  both production builds passed for the earlier candidate. No failing test names.
- Docker production image built successfully. A container with empty tmpfs
  config, database, library and download directories created schema 46.
  SQLite `quick_check` returned `ok`; `foreign_key_check` returned no rows.
  The only startup health warning was the absent TIDAL login.
- Real FLAC, M4A and MP3 integration tests wrote local lyrics and the complete
  ISRC list, then required a second retag and preview to make no changes.
  ID3v2.3 and ID3v2.4 serialization and decoded-audio preservation were checked.
  The packaged Mutagen M4A compatibility writer also retained both ISRCs.
- On the local Bastille library, a refresh and 35-file retag completed, and a
  newly downloaded album completed import during the earlier candidate run.
  After adding multivalue ISRCs, that candidate container retagged three additional
  files without errors. Reading the files confirmed all two or three canonical
  ISRCs, and the subsequent preview was empty.
- Two browser regression tests passed at 1440 and 390 pixels. Parked downloads
  displayed waiting status without stale import progress. Real Bastille album
  pages were also inspected at both widths, with no page errors or horizontal
  overflow. The queue regression uses a captured item with stubbed queue data.
- On the copied catalog, a warm Bastille video-repair run fell from 19.3 to
  5.5 seconds. This is a local diagnostic, not a production latency guarantee.

## Remaining production verification

The live 2.16.9 server still reported contention in the final status sample.
2.16.10 needs to run there before judging sustained refresh/import throughput
or retrying affected jobs. A live Tom Waits import also reported several tag
mismatches; the file's later tags differed from the original failure, so its
exact failure cause was not established. Do not treat all historical failures
as proven fixed or automatically replay imports that may have moved files.

MusicBrainz mirror replication remains separate work. Its last verified
replication timestamp was 2026-07-04. This release does not repair the mirror.
