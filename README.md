<p align="center">
  <img src="app/public/assets/images/logo.png" alt="Discogenius" width="280" />
</p>

<h1 align="center">Discogenius</h1>

<p align="center">
  A self-hosted music library manager in the Lidarr mold: MusicBrainz identity,
  curated discographies, and streaming-provider availability/downloads.
</p>

<p align="center">
  <a href="https://github.com/rhjanssen/discogenius/releases">
    <img src="https://img.shields.io/github/v/release/rhjanssen/discogenius?style=flat-square&logo=github" alt="GitHub Release" />
  </a>
  <a href="https://hub.docker.com/r/rhjanssen/discogenius">
    <img src="https://img.shields.io/docker/pulls/rhjanssen/discogenius?style=flat-square&logo=docker" alt="Docker Pulls" />
  </a>
  <a href="https://github.com/rhjanssen/discogenius">
    <img src="https://img.shields.io/github/stars/rhjanssen/discogenius?style=flat-square&logo=github" alt="GitHub Stars" />
  </a>
</p>

> [!WARNING]
> Discogenius is **not** affiliated with Amazon Music, Apple Music, Deezer,
> Google/YouTube, Spotify, TIDAL, MusicBrainz/MetaBrainz, or Lidarr. Provider
> tools and credentials are yours to use lawfully — **do not** use Discogenius
> to distribute or pirate music.

## Features

- MusicBrainz-canonical artists, release groups, releases, tracks, and recordings
- Curated stereo / spatial / music-video library slots with discography deduplication
- Provider plugins for availability, previews, downloads, and allowed metadata supplements
- Organize, retag, fingerprint (AcoustID), and import existing libraries
- Lidarr-style command queue, scheduling, and quality profiles

## Demo

<p align="center">
  <img src=".github/discogenius-demo.gif" alt="Discogenius demo" width="100%" />
</p>

## Getting started

### Docker (recommended)

Copy [`docker-compose.example.yml`](docker-compose.example.yml) (or use the
snippet below), set paths/PUID/PGID, then:

```bash
docker compose up -d
```

```yaml
services:
  discogenius:
    # Prefer a release tag on NAS hosts that cache `latest` aggressively.
    image: rhjanssen/discogenius:latest
    container_name: discogenius
    environment:
      - PUID=1000
      - PGID=1000
      - PORT=${PORT:-3737}
      - TZ=Etc/UTC
    ports:
      - ${DISCOGENIUS_BIND_IP:-127.0.0.1}:${PORT:-3737}:${PORT:-3737}
    volumes:
      - /path/to/config:/config
      - /path/to/downloads:/downloads   # optional staging area
      - /path/to/library:/library
    restart: unless-stopped
```

Open [http://localhost:3737](http://localhost:3737).

| Volume | Purpose |
| --- | --- |
| `/config` | SQLite DB, settings, provider tokens (persist this) |
| `/downloads` | Transient download workspace (optional but recommended) |
| `/library` | Your music library roots |

**Apple Music downloads** need the `apple-music-wrapper` service in the compose
file (FairPlay decryption). It starts with a normal `docker compose up -d`.
Delete that service block from the compose file if you will not use Apple Music
downloads — catalog/auth still work without it.

**Updates:**

```bash
docker compose pull && docker compose up -d
```

Pin a release tag (for example `rhjanssen/discogenius:2.4.0`) if your host
keeps serving a cached `latest`.

> **Note:** Image upgrades that bump the SQLite schema version currently require
> a fresh `/config` database (files on disk can stay). Prefer soak/test
> deployments until schema migrations ship.

### Streaming providers

MusicBrainz is the catalog source of truth. Providers supply offers, downloads,
artwork/previews, and allowed supplements — not a parallel catalog.

| Provider | Status | Catalog | Downloads |
| --- | --- | --- | --- |
| **TIDAL** | Connect in Auth | TIDAL API (device login) | `tiddl` — stereo / hi-res / Atmos / video |
| **Apple Music** | Connect in Auth | Media-user token | Downloader + optional decrypt wrapper — AAC/ALAC / Atmos / video |
| **YouTube Music** | Connect in Auth | Public `ytmusicapi` (+ optional cookies) | `yt-dlp` — lossy audio / video |
| **Deezer** | Connect in Auth | Public Deezer API | Streamrip (+ `arl`) — MP3 / FLAC |
| **Amazon Music** | Soon | Unofficial API (in-tree) | Re-enable when token host is reliable |
| **Spotify** | Soon | Official Web API (in-tree) | Re-enable when connect UX is simpler |

Auth-page cards show the exact credential fields and steps. Tool versions,
sidecars, and packaging notes live in
[docs/EXTERNAL_DEPENDENCIES.md](docs/EXTERNAL_DEPENDENCIES.md); backend choices
in [docs/PROVIDER_DOWNLOADER_DECISION.md](docs/PROVIDER_DOWNLOADER_DECISION.md).

### From source

Requires Node.js 22+, Yarn 1.22.x, and (for live downloads) the provider tools
documented in [docs/EXTERNAL_DEPENDENCIES.md](docs/EXTERNAL_DEPENDENCIES.md).

```bash
yarn install
yarn dev          # API + app
yarn ci           # lint, typecheck, api tests, build
```

Contributor rules: [AGENTS.md](AGENTS.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | Full documentation map |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current architecture |
| [docs/MB_LOCAL_MODE.md](docs/MB_LOCAL_MODE.md) | Local MusicBrainz catalog mode |
| [docs/CURATION_DEDUPLICATION.md](docs/CURATION_DEDUPLICATION.md) | Slot curation & deduplication |
| [docs/TASKS.md](docs/TASKS.md) | Outstanding work |
| [CHANGELOG.md](CHANGELOG.md) | Shipped history |

## Support

Bugs and feature requests: [GitHub Issues](https://github.com/rhjanssen/discogenius/issues).

## Contributing

1. Fork and create a feature branch
2. Keep changes focused; open an issue first for large work
3. Run `yarn ci` before opening a pull request
4. Follow [AGENTS.md](AGENTS.md)

## Disclaimers

Provider integrations use official APIs, unofficial APIs, and third-party
download tools. You are responsible for accounts, subscriptions, regional
entitlements, and compliance with each service’s terms (including
[Spotify’s Developer Policy](https://developer.spotify.com/policy) if/when
Spotify downloads are re-enabled).

This project includes AI-assisted code. Review carefully before production use:
features may be incomplete, and subtle bugs are possible.
