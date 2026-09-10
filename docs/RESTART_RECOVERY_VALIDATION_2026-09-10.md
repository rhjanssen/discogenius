# Restart recovery audit, 10 September 2026

## Confirmed production failure

The live server was running 2.16.7. Its log contained `Failed to start command executor: Error: database is locked` from `recoverInterruptedJobsByTypes` during `CommandExecutor.start`. All three command workers were idle, while two commands retained expired leases and new RenameArtist 10116 and RetagArtist 10117 remained queued.

The executor set its running flag before synchronous restart recovery. A competing startup writer made recovery throw. The polling loop never started, but the running flag remained set, preventing another start call from repairing the state. The separate downloader could continue, so a successful download did not prove the maintenance queue was running.

Download command 10111 was already importing before restart. Its failure explicitly reports interrupted import execution. Automatic replay remains disabled for an import that may already have modified library files.

## Repair

Restart recovery now awaits writer admission, and the server awaits recovery before scheduling metadata work. If recovery still throws, workers start anyway so the in-loop watchdog can reclaim expired leases. Scheduled-task initialization and the initial metadata enqueue also wait for writer admission.

This follows the same boundary used for normal queue recovery: durable queue changes finish before execution begins. It does not retry partially completed filesystem operations.

## Validation

Two regressions fail on the released 2.16.7 executor and pass on the repaired executor: startup behind another writer, and workers starting after failed recovery. All 20 command-lease tests pass against the active schema.

The built container ran a real executor against a new database with a command owned by a previous process. Another writer held admission for 200 ms. Startup waited, recovered the command, and the actual CheckHealth handler completed it on attempt two without an error. A full server container with empty library data also started the executor successfully.

The live dashboard was loaded in a browser without JavaScript errors. It displayed the queued workload and an import at 86 percent with 100 of 100 files, followed by active provider downloads. These displays do not prove those jobs are advancing; post-update verification must check timestamps and terminal outcomes.

A separate live log recorded a 20-second unmapped-files request. Its route computes candidate guesses before returning the list; the performance of that path remains to be investigated independently of restart recovery.
