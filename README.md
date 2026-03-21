<p align="center">
  <img src="app/public/assets/images/logo.png" alt="Discogenius" width="280" />
</p>

<h1 align="center">Discogenius</h1>

<p align="center">A self-hosted TIDAL library manager for building and maintaining a local, curated discography.</p>

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
- [Screenshots](#screenshots)
- [Getting Started](#getting-started)
- [Support](#support)
- [Contributing](#contributing)
- [License & Disclaimers](#license--disclaimers)

> [!WARNING]
> **Disclaimer**
>
> - Discogenius is an independent project and is **not affiliated with, endorsed by, or associated with TIDAL**.
> - This software is provided for personal use only and requires your own active TIDAL subscription. You are responsible for complying with service terms and applicable copyright and intellectual property laws.
> - **Do not use Discogenius to distribute or pirate music.**

## Features

- **Curated Discography Management**: Build and maintain your personal music collection.
- **TIDAL Integration**: Curate and auto-download complete or partial artist discographies.
- **Smart Library Organization**: Automatic file organization, metadata enrichment, fingerprint-based identification, and deduplication.
- **Download Management**: Queue with Lidarr-style command exclusivity, background scheduling, and quality profiles.
- **Manual Import Flow**: Dashboard interface for identifying and importing local music files.

## Screenshots
<p align="center">
  <img src="docs/images/readme/library-overview.png" alt="Discogenius library overview" width="100%" />
</p>

<p align="center">
  <img src="docs/images/readme/dashboard-overview.png" alt="Discogenius dashboard" width="100%" />
</p>

<p align="center">
  <img src="docs/images/readme/settings-overview.png" alt="Discogenius settings" width="100%" />
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
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    ports:
      - 3737:3737
    volumes:
      - /any/path/to/discogenius/config:/config
      - /any/path/to/your/library:/library
    restart: unless-stopped
```

#### docker run

```bash
docker run -d \
  --name discogenius \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Etc/UTC \
  -p 3737:3737 \
  -v /any/path/to/discogenius/config:/config \
  -v /any/path/to/your/library:/library \
  --restart unless-stopped \
  rhjanssen/discogenius:latest
```

Open the app at http://localhost:3737

#### Configuration

**PUID / PGID**: Set the host user ID. Most NAS setups should configure explicitly.

**TZ**: Container timezone. Use `Etc/UTC` or your local timezone.

**Port Binding**: By default `3737:3737` publishes on all interfaces. For localhost only:

```yaml
ports:
  - 127.0.0.1:3737:3737
```

**Updating**: Pull and restart:

```bash
docker compose pull
docker compose up -d
```

**Note**: Some platforms cache `latest` aggressively. Pin a release tag (e.g., `rhjanssen/discogenius:1.0.5`) if redeploying continues to use an older image.

### Local Development

#### Prerequisites

- Node.js 20+
- Yarn 1.22.x
- Python 3.12 + `tidal-dl-ng-for-dj` in a repo-local `.venv`
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
- [Roadmap](docs/ROADMAP.md) — Planned features and direction

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

See [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md) for development guidelines.

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







