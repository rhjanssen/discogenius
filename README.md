<p align="center">
  <img src="app/public/assets/images/logo.png" alt="Discogenius" width="280" />
</p>

<h1 align="center">Discogenius</h1>

<p align="center">A self-hosted MusicBrainz/Lidarr-style library manager for building and maintaining a local, curated discography with provider-backed availability and downloads.</p>

<p align="center">
  <a href="https://github.com/rhjanssen/discogenius/releases" target="_blank">
    <img src="https://img.shields.io/github/v/release/rhjanssen/discogenius?style=for-the-badge&logo=github" alt="GitHub Release" />
  </a>
  <a href="https://hub.docker.com/r/rhjanssen/discogenius" target="_blank">
    <img src="https://img.shields.io/docker/pulls/rhjanssen/discogenius?style=for-the-badge&logo=docker" alt="Docker Pulls" />
  </a>
  <a href="https://github.com/rhjanssen/discogenius" target="_blank">
    <img src="https://img.shields.io/github/stars/rhjanssen/discogenius?style=for-the-badge&logo=github" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/backend-Express-111827?style=for-the-badge&logo=express&logoColor=white" alt="Express backend" />
  <img src="https://img.shields.io/badge/frontend-React-0f172a?style=for-the-badge&logo=react&logoColor=61dafb" alt="React frontend" />
  <img src="https://img.shields.io/badge/runtime-Docker-0b3b66?style=for-the-badge&logo=docker&logoColor=white" alt="Docker runtime" />
  <img src="https://img.shields.io/badge/database-SQLite-1f2937?style=for-the-badge&logo=sqlite&logoColor=74c0fc" alt="SQLite database" />
  <img src="https://img.shields.io/badge/language-TypeScript-1e3a8a?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

## Table of Contents

- [Features](#features)
- [Demo](#demo)
- [Getting Started](#getting-started)
- [Support](#support)
- [Contributing](#contributing)
- [License & Disclaimers](#license--disclaimers)

> [!WARNING]
> **Disclaimer**
>
> - Discogenius is an independent project and is **not affiliated with, endorsed by, or associated with Amazon Music, Apple Music, Deezer, Google/YouTube, Spotify, TIDAL, MusicBrainz, MetaBrainz, or Lidarr**.
> - Provider integrations use a mixture of official APIs, unofficial APIs, and third-party download tools. Accounts, subscriptions, tokens, cookies, and regional entitlements remain yours; you are responsible for complying with each service's terms and applicable copyright and intellectual property laws. In particular, the optional Spotify downloader must be used consistently with [Spotify's Developer Policy](https://developer.spotify.com/policy).
> - **Do not use Discogenius to distribute or pirate music.**

## Features

- **MusicBrainz/Lidarr-style Library Identity**: Manage artists, release groups, releases, tracks, and recordings using canonical MusicBrainz metadata.
- **Provider-backed Availability & Downloads**: Provider plugins for **TIDAL, Apple Music, Amazon Music, Spotify, YouTube / YouTube Music, and Deezer**, with provider-specific catalog, preview, stereo, spatial-audio, and music-video capabilities described below.
- **Curated Discography Management**: Curate complete or partial artist discographies with monitored release-group slots.
- **Smart Library Organization**: Automatic file organization, metadata enrichment, fingerprint-based identification, and deduplication.
- **Download Management**: Queue with Lidarr-style command exclusivity, background scheduling, and quality profiles.
- **Manual Import Flow**: Dashboard interface for identifying and importing local music files.

## Demo
<p align="center">
  <img src=".github/discogenius-demo.gif" alt="Discogenius demo" width="100%" />
</p>

## Getting Started

### Docker Install (Recommended)

#### docker-compose.yml

```yaml
services:
  discogenius:
    # Pin release tags on NAS/custom-app platforms when possible.
    # Some hosts cache `latest` aggressively unless you force a pull.
    image: rhjanssen/discogenius:latest
    container_name: discogenius
    env_file:
      - .env
    environment:
      - PUID=1000
      - PGID=1000
      - PORT=${PORT:-3737}
      - TZ=Etc/UTC
    ports:
      - ${DISCOGENIUS_BIND_IP:-127.0.0.1}:${PORT:-3737}:${PORT:-3737}
    volumes:
      - /any/path/to/discogenius/config:/config
      - /any/path/to/discogenius/downloads:/downloads
      - /any/path/to/your/library:/library
    restart: unless-stopped

  # Optional Apple Music decryption sidecar (only required for Apple Music downloads)
  apple-music-wrapper:
    image: ghcr.io/itouakirai/wrapper:x86
    profiles: ["apple-music"]
    network_mode: "service:discogenius"
    entrypoint: ["/bin/bash", "/app/wrapper-entrypoint.sh"]
    depends_on:
      - discogenius
    volumes:
      - /any/path/to/discogenius/config/providers/apple-music/wrapper-rootfs/data:/app/rootfs/data
      - /any/path/to/discogenius/config/providers/apple-music/wrapper-entrypoint.sh:/app/wrapper-entrypoint.sh
    restart: unless-stopped
```

#### docker run

For the base application with all bundled provider tools but without the
Apple Music decryption sidecar:
```bash
docker run -d \
  --name discogenius \
  -e PUID=1000 \
  -e PGID=1000 \
  -e PORT=3737 \
  -e TZ=Etc/UTC \
  -p 127.0.0.1:3737:3737 \
  -v /any/path/to/discogenius/config:/config \
  -v /any/path/to/discogenius/downloads:/downloads \
  -v /any/path/to/your/library:/library \
  --restart unless-stopped \
  rhjanssen/discogenius:latest
```

To run with the optional Apple Music decryption sidecar enabled:
```bash
docker compose --profile apple-music up -d
```

`/downloads` is a transient staging workspace (in-progress downloads before
they are imported into the library). Mounting it is optional but keeps large
temporary files out of the container's writable layer.

Open the app at [http://localhost:3737](http://localhost:3737)

#### Configuration

**PUID / PGID**: Set the host user ID. Most NAS setups should configure explicitly.

**TZ**: Container timezone. Use `Etc/UTC` or your local timezone.

**Port Binding**: Docker Compose reads `PORT` from `.env` and uses it for both the app listener and published port, defaulting to `127.0.0.1:3737:3737`. Change `PORT` in `.env` to move Docker to a different port. To expose Discogenius on all interfaces instead of localhost-only:

```yaml
ports:
  - 0.0.0.0:${PORT:-3737}:${PORT:-3737}
```

**Updating**: Pull and restart:

```bash
docker compose pull
docker compose up -d
```

**Note**: Some platforms cache `latest` aggressively. Pin a release tag (e.g., `rhjanssen/discogenius:2.0.0`) if redeploying continues to use an older image.

### Streaming Providers

MusicBrainz remains the canonical identity for artists, releases, and
recordings. Streaming providers contribute availability, download offers,
artwork, previews, and allowed metadata supplements; they do not create a
parallel provider catalog in the Discogenius database.

| Provider | Catalog integration | Download integration | Current scope |
| --- | --- | --- | --- |
| TIDAL | TIDAL API with app-managed device login | `tiddl` | Lossy/lossless/hi-res stereo, Dolby Atmos, music videos, previews, and lyrics |
| Apple Music | Apple Music API using a media-user token | `apple-music-downloader` plus the optional decryption-wrapper sidecar | AAC/ALAC through 24-bit/192kHz, Dolby Atmos, music videos, and previews. The catalog provider does **not** claim lyrics support, and upstream lyric embedding is disabled because it crashes on tracks without TTML lyrics. |
| Amazon Music | Unofficial external API because Amazon's official Web API remains closed beta | `amazon-music==1.7.7` through a non-interactive bridge | Stereo, lossless/hi-res, and Dolby Atmos where the external API, account tier, and region expose them |
| Spotify | Official Spotify Web API using client credentials | Optional `votify[librespot]==1.9.9` | Catalog, artwork, 30-second previews where Spotify supplies them, and lossy stereo downloads. No lossless, spatial, or video capability is advertised. |
| YouTube / YouTube Music | Public `ytmusicapi` catalog and lyrics access, with optional authenticated browser headers | `yt-dlp` plus FFmpeg | Lossy Opus/AAC audio, synchronized lyrics where YouTube exposes them, and source-resolution video. Browser headers/cookies are needed for account library sources, age/region-restricted media, or other authenticated features. |
| Deezer | Public Deezer API | Streamrip with an ARL cookie | Public catalog and previews without authentication; MP3 up to 320 kbps or 16-bit FLAC downloads with a valid ARL/account entitlement |

Provider cards on the Auth page render their credential fields from each
plugin's manifest:

- **TIDAL:** use the in-app device-login flow; no token copying is required.
- **Apple Music:** provide the `media-user-token`; the bearer/developer token
  and two-letter storefront are optional because Discogenius can resolve the
  web bearer token and detect the storefront. Apple downloads additionally
  require the wrapper profile and its one-time Apple ID/2FA login; Discogenius
  does not persist that Apple ID or password.
- **Amazon Music:** provide an access token for a compatible unofficial API.
  The API base URL is optional and defaults to the provider's configured
  external service. Custom public endpoints must use HTTPS; a private or
  loopback self-hosted endpoint additionally requires
  `DISCOGENIUS_ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE=true` so a pasted URL cannot
  silently turn provider authentication into an internal-network request.
- **Spotify:** provide a Spotify for Developers client ID and client secret for
  catalog access. Paste Netscape-format `cookies.txt` content, or a path visible
  inside the container, only when enabling Votify downloads.
- **YouTube / YouTube Music:** no credentials are required for public catalog
  access. Optional browser-header JSON and cookies unlock authenticated library
  sources and help `yt-dlp` access restricted media.
- **Deezer:** public catalog access needs no credentials. A signed-in session's
  `arl` cookie is required only for Streamrip downloads.

The production Docker image bundles the directly spawned tools in isolated,
pinned runtimes: `tiddl==3.4.4`, `ytmusicapi==1.12.1`, `yt-dlp==2026.7.4`,
`streamrip==2.1.0`, `amazon-music==1.7.7`, and
`votify[librespot]==1.9.9`, plus FFmpeg, MP4Box, mp4decrypt, and fpcalc. The
Apple decryption wrapper remains an opt-in Compose sidecar. Bundling the tools
does not supply service credentials, subscriptions, or download entitlements.

### Local Development

#### Prerequisites

- Node.js 22+
- Yarn 1.22.x
- Python 3.13+ with `tiddl` on PATH (`pip install tiddl`) for TIDAL downloads
- Upstream `apple-music-downloader` and `apple-music-wrapper` (for Apple Music downloads)
- Provider-specific Python environments for `ytmusicapi`/`yt-dlp`, Streamrip,
  `amazon-music`, and Votify when exercising those download backends locally
- FFmpeg on PATH (video conversion, FLAC extraction)
- Docker (optional, for parity testing)

#### Install & Run

```bash
yarn install
yarn dev
```

#### Build & Lint

```bash
yarn build
yarn lint
```

#### Docker Build

```bash
docker compose up -d --build
```

## Support

### Documentation

- [Architecture Guide](docs/ARCHITECTURE.md) — System design and service responsibilities
- [Curation & Deduplication](docs/CURATION_DEDUPLICATION.md) — How discography curation works
- [Task Backlog & Roadmap](docs/TASKS.md) — Versioned plan and outstanding work

### Issues & Feedback

Report bugs and request features on [GitHub Issues](https://github.com/rhjanssen/discogenius/issues).

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to your branch (`git push origin feature/your-feature`)
5. Open a pull request

For significant changes, open an issue first to discuss your proposal.

See [AGENTS.md](AGENTS.md) for development guidelines and agent expectations.

## License & Disclaimers

### AI-Assisted Code

This project was produced using AI-assisted code generation.

That means:

- Code quality is not guaranteed.
- Features may be incomplete or behave incorrectly.
- Performance may be worse than expected.
- Security and data-safety mistakes may exist.
- AI can make serious mistakes, including subtle logic bugs that are easy to miss.

Please review code carefully before deploying in production.
