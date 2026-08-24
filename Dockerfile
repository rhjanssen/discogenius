# tiddl requires Python >= 3.13
ARG APPLE_MUSIC_DOWNLOADER_IMAGE=ghcr.io/zhaarey/apple-music-downloader@sha256:e5f84e46ac4e7adc3c64ad462a0f328ac2f934ed7152d83840792bd21621aac1
FROM python:3.13-slim-bookworm AS base

# Install Node.js 22.x and system dependencies. yt-dlp's YouTube EJS challenge
# solver requires Node 22 or newer (and Node is also the Discogenius runtime).
# curl/gnupg are only needed to set up the NodeSource repo and are purged again.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg ffmpeg gosu libchromaprint-tools \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && npm install -g yarn \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install tiddl (TIDAL downloader) in its own venv
RUN python3 -m venv /opt/tiddl-venv \
    && /opt/tiddl-venv/bin/pip install --no-cache-dir tiddl==3.4.4 \
    && /opt/tiddl-venv/bin/pip check \
    && rm -rf /opt/tiddl-venv/lib/python3.13/site-packages/pip* /opt/tiddl-venv/bin/pip* \
    && ln -s /opt/tiddl-venv/bin/tiddl /usr/local/bin/tiddl

# Core media tagging uses Mutagen to replace embedded cover atoms without
# sacrificing MusicBrainz/freeform tags (ffmpeg's MP4 mdta mode drops `covr`).
RUN pip install --no-cache-dir mutagen==1.47.0 \
    && pip check

# Keep every third-party provider runtime isolated. Their dependency graphs
# intentionally overlap at incompatible versions (notably Pillow, Rich and
# protobuf), so installing them into one environment would make builds depend
# on pip's resolver order.
RUN python3 -m venv /opt/ytmusic-venv \
    && /opt/ytmusic-venv/bin/pip install --no-cache-dir \
        ytmusicapi==1.12.1 'yt-dlp[default]==2026.7.4' \
    && /opt/ytmusic-venv/bin/pip check \
    && rm -rf /opt/ytmusic-venv/lib/python3.13/site-packages/pip* /opt/ytmusic-venv/bin/pip*

RUN python3 -m venv /opt/streamrip-venv \
    && /opt/streamrip-venv/bin/pip install --no-cache-dir streamrip==2.1.0 \
    && /opt/streamrip-venv/bin/pip check \
    && rm -rf /opt/streamrip-venv/lib/python3.13/site-packages/pip* /opt/streamrip-venv/bin/pip*

# Spotify and Amazon remain deliberately exposed as Soon in the UI. Their
# download backends are hard-disabled, so shipping their large Python runtimes
# would add pull cost without providing a callable capability. Reintroduce the
# pinned environments together with the provider enablement work.

# Upstream Apple Music downloader image is currently amd64-only and provides a
# static Go binary at /usr/local/bin/apple-music-dl. Copying just that binary
# avoids switching Discogenius' base image away from the Python runtime tiddl
# depends on.
FROM ${APPLE_MUSIC_DOWNLOADER_IMAGE} AS apple_music_downloader

# Debian bookworm ships no gpac package and the upstream downloader image's
# MP4Box is dynamically linked against Ubuntu 26.04 (newer glibc), so build a
# static MP4Box from a pinned GPAC release for the mux step of Apple downloads.
FROM debian:bookworm-slim AS gpac_builder
ARG GPAC_ARCHIVE_URL=https://github.com/gpac/gpac/archive/refs/tags/v2.4.0.tar.gz
ARG GPAC_ARCHIVE_SHA256=99c8c994d5364b963d18eff24af2576b38d38b3460df27d451248982ea16157a
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "$GPAC_ARCHIVE_URL" -o /tmp/gpac.tar.gz \
    && echo "$GPAC_ARCHIVE_SHA256  /tmp/gpac.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/gpac \
    && tar -xzf /tmp/gpac.tar.gz --strip-components=1 -C /tmp/gpac \
    && rm /tmp/gpac.tar.gz \
    && cd /tmp/gpac \
    && ./configure --static-bin \
    && make -j"$(nproc)" \
    && strip bin/gcc/MP4Box

# mp4decrypt (Bento4) is required for Apple music-video decryption. Official
# prebuilt SDK, pinned.
FROM debian:bookworm-slim AS bento4_fetcher
ARG BENTO4_SDK_URL=https://www.bok.net/Bento4/binaries/Bento4-SDK-1-6-0-641.x86_64-unknown-linux.zip
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL "$BENTO4_SDK_URL" -o /tmp/bento4.zip \
    && unzip -q /tmp/bento4.zip -d /tmp/bento4 \
    && install -m 0755 /tmp/bento4/*/bin/mp4decrypt /usr/local/bin/mp4decrypt \
    && rm -rf /var/lib/apt/lists/* /tmp/bento4.zip

# ==================== Builder Stage ====================
FROM base AS builder

WORKDIR /app

# Copy package files (workspaces setup)
COPY package.json yarn.lock ./
COPY api/package.json ./api/
COPY app/package.json ./app/

# Install all workspace dependencies from root lockfile
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn/v6,sharing=locked \
    yarn install --frozen-lockfile

# Copy source code
COPY api ./api
COPY app ./app

# Build frontend
RUN yarn --cwd app build

# Build backend
RUN yarn --cwd api build

# ==================== Production Stage ====================
FROM base AS production

WORKDIR /app

# Create non-root user (Python image doesn't have 'node' user like Node.js image)
RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

# Create directories and set permissions
RUN mkdir -p /config /downloads /library/stereo-music /library/spatial-music /library/music-videos /app \
    && chown -R node:node /config /downloads /library /app

# Copy package files. Only the api workspace gets runtime dependencies — the
# frontend ships as pre-built static files, so installing its React/Fluent
# dependency tree would only bloat the image. app/package.json itself stays:
# the server's repo-root detection expects both workspace manifests on disk.
COPY --chown=node:node package.json yarn.lock ./
COPY --chown=node:node api/package.json ./api/
COPY --chown=node:node app/package.json ./app/
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn/v6,sharing=locked \
    node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.workspaces=['api'];fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
    && yarn install --frozen-lockfile --production --ignore-optional \
    && find ./node_modules -type f \( -name '*.d.ts' -o -name '*.md' -o -name '*.map' -o -name 'README*' -o -name 'LICENSE*' -o -name 'CHANGELOG*' \) -delete \
    && find ./node_modules -type d \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'docs' -o -name 'examples' -o -name '.github' \) -exec rm -rf {} + 2>/dev/null \
    && rm -rf \
        ./node_modules/better-sqlite3/deps \
        ./node_modules/better-sqlite3/src \
        ./node_modules/node-taglib-sharp/src

# Copy built files from builder
COPY --from=builder --chown=node:node /app/api/dist ./api/dist
COPY --from=builder --chown=node:node /app/app/dist ./app/dist

# Copy the static Apple Music downloader binary from the upstream runtime image.
# Keep both names on PATH: upstream uses apple-music-dl, older Discogenius
# diagnostics allowed APPLE_MUSIC_DL_BIN=apple-music-downloader.
COPY --from=apple_music_downloader /usr/local/bin/apple-music-dl /usr/local/bin/apple-music-dl
RUN chmod +x /usr/local/bin/apple-music-dl \
    && ln -sf /usr/local/bin/apple-music-dl /usr/local/bin/apple-music-downloader

# MP4Box (static, built above) + mp4decrypt for Apple Music mux/decrypt steps.
COPY --from=gpac_builder /tmp/gpac/bin/gcc/MP4Box /usr/local/bin/MP4Box
COPY --from=bento4_fetcher /usr/local/bin/mp4decrypt /usr/local/bin/mp4decrypt

# Copy only the Python bridges invoked by the compiled server. TypeScript source
# and tests are not runtime assets.
COPY --chown=node:node api/src/services/mediafiles/mutagen-cover-bridge.py ./api/src/services/mediafiles/mutagen-cover-bridge.py
COPY --chown=node:node api/src/services/providers/deezer/streamrip-bridge.py ./api/src/services/providers/deezer/streamrip-bridge.py
COPY --chown=node:node api/src/services/providers/tidal/tiddl-progress-wrapper.py ./api/src/services/providers/tidal/tiddl-progress-wrapper.py
COPY --chown=node:node api/src/services/providers/youtube-music/ytmusicapi-bridge.py ./api/src/services/providers/youtube-music/ytmusicapi-bridge.py
RUN chmod +x ./api/src/services/providers/deezer/streamrip-bridge.py

# Copy entrypoint that maps container permissions to the requested host uid/gid.
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3737

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3737
ENV DISCOGENIUS_BIND_IP=0.0.0.0
ENV DOCKER=true
# tiddl stores auth.json/config.toml in TIDDL_PATH, kept beside the rest of the
# TIDAL plugin files inside the config volume. Startup migrates a pre-2.0.2
# /config/.tiddl into this location automatically.
ENV TIDDL_PATH=/config/providers/tidal/.tiddl
ENV APPLE_MUSIC_DL_BIN=apple-music-dl
ENV YTMUSICAPI_PYTHON_BIN=/opt/ytmusic-venv/bin/python
ENV YT_DLP_BIN=/opt/ytmusic-venv/bin/yt-dlp
ENV STREAMRIP_BIN=/app/api/src/services/providers/deezer/streamrip-bridge.py

# Declare volumes for persistent data
VOLUME ["/config", "/downloads", "/library"]

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3737') + '/ping').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run production server
CMD ["node", "--experimental-specifier-resolution=node", "api/dist/index.js"]
