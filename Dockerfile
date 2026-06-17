# tiddl requires Python >= 3.13
FROM python:3.13-slim-bookworm AS base

# Install Node.js 20.x and system dependencies.
# curl/gnupg are only needed to set up the NodeSource repo and are purged again.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg ffmpeg gosu libchromaprint-tools \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && npm install -g yarn \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install tiddl (TIDAL downloader) in its own venv
RUN python3 -m venv /opt/tiddl-venv \
    && /opt/tiddl-venv/bin/pip install --no-cache-dir tiddl==3.4.3 \
    && ln -s /opt/tiddl-venv/bin/tiddl /usr/local/bin/tiddl

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
    && find ./node_modules -type d \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'docs' -o -name 'examples' -o -name '.github' \) -exec rm -rf {} + 2>/dev/null || true

# Copy built files from builder
COPY --from=builder --chown=node:node /app/api/dist ./api/dist
COPY --from=builder --chown=node:node /app/app/dist ./app/dist

# Copy source files needed at runtime (for ES modules)
COPY --chown=node:node api/src ./api/src

# Copy entrypoint that maps container permissions to the requested host uid/gid.
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3737

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3737
ENV DOCKER=true
# tiddl stores auth.json/config.toml in TIDDL_PATH, kept beside the rest of the
# TIDAL plugin files inside the config volume. Startup migrates a pre-2.0.2
# /config/.tiddl into this location automatically.
ENV TIDDL_PATH=/config/providers/tidal/.tiddl

# Declare volumes for persistent data
VOLUME ["/config", "/downloads", "/library"]

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3737') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run production server
CMD ["node", "--experimental-specifier-resolution=node", "api/dist/index.js"]
