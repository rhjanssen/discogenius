# External dependency policy

Discogenius uses external tools in two different roles. They should not be
packaged the same way.

## 1. Core image tools

Small runtime tools that Discogenius directly executes can be bundled into the
Discogenius image when they are needed for normal operation or for a provider
backend selected by the user.

Rules:

- Prefer package managers or pinned release/image artifacts.
- Do not `git clone` mutable external repositories during a Docker build.
- Pin external image/binary sources by version or digest. Use a build argument
  only as an explicit override for maintainers.
- Keep provider-specific tools behind capability flags and diagnostics when
  they are not fully provisioned.
- Keep the final runtime path stable and configurable through an env var.

Examples:

- `ffmpeg`, `fpcalc`, `gosu`: installed from Debian packages.
- `tiddl`: installed into its own Python virtual environment and exposed as
  `tiddl`.
- Apple Music downloader: copied as the pinned upstream static
  `apple-music-dl` binary, with `APPLE_MUSIC_DL_BIN` as the override.

## 2. Provider companion services

Some provider backends need a sidecar process that is not part of the core
Discogenius server. These should be optional Compose profiles or documented
external services, not always-on dependencies.

Rules:

- Keep them disabled by default.
- Put provider-owned state under `config/providers/<provider>/`.
- Prefer pinned images when the image becomes a release dependency.
- Surface readiness through provider diagnostics before a download is started.
- Share networking intentionally. If the provider CLI expects `127.0.0.1`, the
  sidecar must share the Discogenius network namespace or the config must point
  at the sidecar service name.

Examples:

- Apple Music decryption wrapper: optional `apple-music` Compose profile,
  sharing Discogenius' network namespace so `127.0.0.1:10020/20020` resolves.
- `MP4Box`: provider prerequisite reported by diagnostics. If we later bundle
  it, use a pinned binary/image source; do not clone GPAC at image build time.

## 3. External catalog stacks

Large, stateful metadata systems are infrastructure, not provider-plugin
dependencies. Discogenius should connect to them through configuration and
networking, not vendor them into its image.

Rules:

- Do not build, clone, or run the catalog stack inside the Discogenius image.
- Keep the external stack user-managed and stateful.
- Provide a Compose overlay only for networking and config wiring.
- Treat the external service as the authority for its domain and keep
  Discogenius data keyed by MusicBrainz IDs/local FKs.

Examples:

- MusicBrainz-docker: user-managed mirror with Postgres, web service, and Solr.
  Discogenius joins its Docker network and derives the Postgres DSN and optional
  `/ws/2` URL from `MB_LOCAL_HOST`.

## Practical rule

If the dependency is a small executable Discogenius directly spawns, bundle or
mount it through a pinned artifact and diagnose it. If it is a stateful service
with its own database, lifecycle, import process, and backups, keep it external
and connect to it.
