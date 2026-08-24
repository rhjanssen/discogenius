<p align="center">
  <img src="app/public/assets/images/logo.png" alt="Discogenius" width="280" />
</p>

<h1 align="center">Discogenius</h1>

<p align="center">
  A self-hosted music collection manager for streaming libraries.
  MusicBrainz identity, curated discographies, and downloads from your
  streaming providers.
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
> Google/YouTube, SoundCloud, Spotify, TIDAL, MusicBrainz/MetaBrainz, or Lidarr.
> Provider tools and credentials are yours to use lawfully — **do not** use
> Discogenius to distribute or pirate music.

## Features

- Monitor artists and download missing albums, tracks, and music videos
- MusicBrainz-canonical catalog with stereo, spatial, and video library slots
- Streaming providers for availability and downloads (TIDAL, Apple Music,
  YouTube Music, Deezer, SoundCloud; Amazon Music and Spotify coming soon)
- Organize, rename, retag, and import existing libraries
- Quality profiles, upgrades, and a command queue with scheduling

## Demo

<p align="center">
  <img src=".github/discogenius-demo.gif" alt="Discogenius demo" width="100%" />
</p>

## Getting started

### Docker (recommended)

Copy [`docker-compose.example.yml`](docker-compose.example.yml), set paths /
PUID / PGID, then:

```bash
docker compose up -d
```

```yaml
services:
  discogenius:
    image: rhjanssen/discogenius:latest
    container_name: discogenius
    environment:
      - PUID=1000
      - PGID=1000
      - PORT=${PORT:-3737}
      - DISCOGENIUS_BIND_IP=0.0.0.0
      - TZ=Etc/UTC
    ports:
      - ${DISCOGENIUS_BIND_IP:-127.0.0.1}:${PORT:-3737}:${PORT:-3737}
    volumes:
      - /path/to/config:/config
      - /path/to/downloads:/downloads
      - /path/to/library:/library
    restart: unless-stopped
```

Open [http://localhost:3737](http://localhost:3737).

| Volume | Purpose |
| --- | --- |
| `/config` | Database, settings, and provider tokens |
| `/downloads` | Temporary download workspace |
| `/library` | Your music library roots |

Apple Music downloads also need the `apple-music-wrapper` service from the
example compose file. Remove that service if you will not use Apple Music
downloads.

**Updates:**

```bash
docker compose pull && docker compose up -d
```

Prefer a pinned tag (for example `rhjanssen/discogenius:2.6.4`) on hosts that
cache `latest` aggressively.

> **Note:** Image upgrades that bump the SQLite schema currently need a fresh
> `/config` database (library files on disk can stay). Prefer soak/test
> deployments until schema migrations ship.

### From source

Requires Node.js 22+ and Yarn 1.22.x.

```bash
yarn install
yarn dev          # API + app
yarn ci           # lint, typecheck, api tests, build
```

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation map |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/EXTERNAL_DEPENDENCIES.md](docs/EXTERNAL_DEPENDENCIES.md) | Provider tools and sidecars |
| [AGENTS.md](AGENTS.md) | Contributor conventions |

## Support

Bugs and feature requests: [GitHub Issues](https://github.com/rhjanssen/discogenius/issues).

## Contributing

1. Fork and create a feature branch
2. Keep changes focused
3. Run `yarn ci` before opening a pull request
4. Follow [AGENTS.md](AGENTS.md)

## Disclaimers

Provider integrations use official APIs, unofficial APIs, and third-party
download tools. You are responsible for accounts, subscriptions, regional
entitlements, and each service’s terms.

This project includes AI-assisted code. Review carefully before production use.
