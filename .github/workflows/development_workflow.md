---
description: Run the development environment locally or in Docker
---

# Development Workflow

Discogenius supports local development (Node + Yarn + a repo-local `.venv` for `tidal-dl-ng`) and Docker-based development for parity with production.

## 1. Prerequisites

- Node.js 20+
- Yarn 1.x
- Python 3.12+ (`py -3.12` on Windows is recommended)
- ffmpeg installed system-wide
- fpcalc (Chromaprint)
- Optional: Docker Desktop (for container builds)

## 2. Local Development (Recommended)

Install dependencies:

```bash
yarn install
```

Bootstrap the repo-local Python environment for `tidal-dl-ng`:

Linux/macOS:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip tidal-dl-ng
```

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip tidal-dl-ng
```

Notes:
- Discogenius auto-detects `.venv\Scripts\tidal-dl-ng.exe` on Windows and `.venv/bin/tidal-dl-ng` on Unix-like systems.
- If you intentionally keep `tidal-dl-ng` elsewhere, set `TIDAL_DL_NG_BIN`.
- Ensure `fpcalc` is available on PATH (or set `FPCALC_PATH` if needed).
- Do not run the Docker stack and the local Windows server against the same `./config` directory at the same time. Both modes share `discogenius.db`, and concurrent writers can corrupt SQLite indexes.

Start both API and frontend:

```bash
yarn dev
```

Or run separately:

```bash
yarn api:dev
yarn app:dev
```

Default URLs:
- API (default `PORT=3737`): `http://localhost:3737/health`
- App (Vite): `http://localhost:8080`

If you set `PORT` in your environment, use that value instead of `3737` for API URLs.

## 3. Docker Development / Parity Check

```bash
docker compose up --build -d
```

For changes that affect packaging, runtime paths, tidal-dl-ng availability, ffmpeg integration, or frontend production assets, prefer validating with Docker even if local `yarn dev` works.

Health check:

```bash
curl http://localhost:3737/health
```

If `PORT` is configured, replace `3737` with your configured value.

Logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```
