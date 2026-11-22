# Frontend UX audit (November 2026)

A pass over the running app (desktop 1440×900 and iPhone 13) against Fluent UI v9 guidance
(`.ref_fluentui` best-practice docs for MessageBar, Popover, InfoLabel, Card, Tooltip) and
Lidarr's information architecture (`.ref_lidarr/frontend`). It starts from the live failures on
Primula (21 Nov), where people could not tell what had failed or why.

Status per finding: **Done** (shipped on `claude/sweet-hypatia-nywmuu`), **Next** (contained,
recommended now) or **Proposal** (structural; needs a product decision).

## 1. Errors people can act on

| Finding | Status |
|---|---|
| Queue, History and Activity cards printed raw tool output: streamrip tracebacks, `yt-dlp exited with code 1: ERROR:`, `[ImportDownload] …`. | **Done.** The server derives a `FailureNotice` once (`api/src/services/commands/failure-presentation.ts`): category, a one-sentence summary, a next-step hint, and an optional in-app action such as the provider sign-in page. Cards show the summary and hint. The raw text sits behind a Fluent Popover ("Details") with a copy button (`app/src/components/ui/FailureNotice.tsx`). This follows Lidarr's status popover (a headline plus reasons) and Fluent's guidance: short text inline, longer content in a Popover. |
| The API client ignored a response's `error` field, so a toast often said only "Request failed". | **Done.** |
| Settings toasts said "Error: Failed to update …" and dropped the server's reason. | **Done.** Toasts now name the action and show the reason. |
| A failed fallback was labelled with the provider the job started on (Deezer), not the one that failed (Apple). | **Done.** |
| Failures that need action (an expired sign-in, a missing tool) appear only as a toast or a row; nothing persists at the place where they matter. | **Next.** Use a `MessageBar` on the surface the failure blocks. `ProviderAuthNotice` already does this for sign-in; use the same pattern for "downloader not installed" (tiddl missing on PATH) on the Dashboard. |
| Track-level `reason` strings inside an album card are still raw. | **Next.** Run them through `presentFailure` on the server, as job errors are. |

## 2. Information architecture

Today the top bar has Library, Dashboard and Settings, icon-only. The Dashboard combines library
statistics, global maintenance actions (refresh, scan, curate, download missing, plus scheduled
tasks under More), the download queue, history, the activity log and unmapped-file import.

| Finding | Status |
|---|---|
| Primary destinations were icon-only. A chart icon for "Dashboard" does not explain itself. | **Done.** Labels appear from 1100 px wide; icons stay on phones. |
| System status had a route but nothing linked to it. On the live server it said "unhealthy" and nobody saw it. | **Done.** Added a System entry. **Next:** add a warning dot fed by a cheap health summary endpoint. Do not poll `/v1/system/status` from the nav: it is heavy, and live requests already take seconds. |
| No **Wanted** view. Nothing tells a person *why* a monitored album is not downloading (no acquisition plan, every offer unavailable, waiting in the queue, failed N times, held by a provider sign-in). DownloadMissing knows ("skipped N editions with no acquisition plan") but only says it in a command description. | **Proposal.** Add a top-level **Wanted** page in the shape of Lidarr's Wanted → Missing / Cutoff Unmet: one row per monitored missing edition, with its reason and a single action (search now, choose a source, unmonitor), and an Upgrades tab for editions below the quality cutoff. This is the largest gap against Lidarr, and the question most of the live debugging was trying to answer. |
| No log viewer. Diagnosing Primula needed `docker logs`, and the logs from before a restart were lost. `api/src/routes/log.ts` exists but has no UI. | **Proposal.** System → Logs, with level and component filters, reading the JSONL log the app already writes. |
| The Dashboard mixes five concerns. | **Proposal.** Split it the way Lidarr does: **Activity** (Queue, History), **Wanted** (Missing, Upgrades), **Library → Import** (Unmapped files), **System** (Status, Tasks, Logs, Backups). Library statistics move to the Library header. Maintenance actions move to System → Tasks, so they are not the first buttons on the busiest page. |

## 3. Dashboard and queue

| Finding | Status |
|---|---|
| Header actions read "Refresh", "Scan", "Curate", "Download" on desktop, which does not say what they act on. | **Done.** Desktop shows the full labels ("Refresh Metadata", "Scan Library Files", "Curate Library", "Download Missing"). Phones keep the short ones. |
| A paused queue showed only an orange Resume button. Nothing said that downloads were paused, or what that means. | **Done.** A warning `MessageBar` ("Downloads are paused …") with a "Resume downloads" action. The tab row offers "Pause downloads" only while running. |
| The provider warning was a hand-built banner (icon, text, badge, button). | **Done.** Now a Fluent `MessageBar`. |
| An empty queue took half the desktop width beside History. | **Done.** It is one line, and History spans the page. |
| Retry from History did nothing (404). | **Done** (server and UI). |
| No bulk recovery. 199 failed albums can only be retried one by one. | **Next.** "Retry all failed" in the History filter menu, scoped to the current filter. Exclude failures whose category is `unavailable`: replanning handles those. |

## 4. Status page

| Finding | Status |
|---|---|
| Eleven passing checks were listed at equal weight. The one failure sat last, and the summary was a small chip showing the raw word "unhealthy". | **Done.** Problems come first and passing checks fold behind "N checks passed". The badge reads "Problems found" or "Needs attention". |
| Write-lock pressure (held 57 s on Primula) is visible only in JSON. | **Next.** A Runtime row with the longest recent hold and its label, which would have pointed at curation immediately. |

## 5. Library and onboarding

| Finding | Status |
|---|---|
| An empty library offered only "Connect Provider", although the text said to add an artist from MusicBrainz. | **Done.** "Add an artist" is the primary action and focuses the global search. "Connect a provider" is secondary. |
| The search placeholder said "Search your library…", but it also searches MusicBrainz, which is how you add music. | **Done.** It now reads "Search or add music…". `OPEN_SEARCH_EVENT` existed with no listener and is now wired. |

## 6. Fluent alignment and accessibility

| Finding | Status |
|---|---|
| 117 `title=` attributes against 4 Fluent `Tooltip`s. Native `title` does not appear on touch or on keyboard focus. Fluent asks for `Tooltip` (with `relationship="label"` on icon-only buttons). | **Next.** Replace `title` on icon-only controls with `Tooltip` first (queue row actions, nav, media cards). |
| 122 toast calls. Fluent keeps toasts for transient, non-blocking confirmation. | **Next.** Keep success toasts. Failures that leave something in a bad state (a settings save, a delete) should show inline at the control (`Field` `validationMessage`, or a MessageBar in the dialog). |
| Custom "glass" surfaces (57 references) and the UltraBlur background give the app its own look over Fluent tokens. | **Proposal.** Keep it as brand, but check contrast in both themes. Secondary text on the blurred background is the weakest spot, for example the "0 monitored • 0 catalog" lines and the History "Details" button. |
| Very large page components: AlbumPage 2,120 lines, ArtistPage 2,019, Library 1,835, Auth 1,695, QueueTab 1,685. | **Proposal.** Split by section as features change. This is not worth a standalone refactor, but avoid adding to these files. |
| A custom DataGrid in 8 places, rather than Fluent's `DataGrid`. | **Proposal.** Keep it where it needs virtualisation. Check that it keeps Fluent's keyboard model (arrow-key cell navigation, `aria-sort`). |

## Verification

- `app/src/pages/dashboard/QueueHistoryPanel.test.tsx`: a history retry uses the command id, and a card shows the cause and next step, with the raw error behind Details.
- `app/src/pages/StatusPage.test.tsx`: problems come first and passing checks fold away.
- `api/src/services/commands/failure-presentation.test.ts`: every live failure text from 18–21 Nov maps to a cause and a next step.
- Checked by hand in Chromium against a scratch database seeded with the live failure texts: "Add an artist" focuses search; the passing-checks disclosure expands; Details opens the raw error.
