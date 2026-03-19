FROM python:3.12-slim-bookworm AS base

# Install Node.js 20.x and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg ffmpeg git gosu libchromaprint-tools \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && npm install -g yarn \
    && rm -rf /var/lib/apt/lists/*

# Install tidal-dl-ng (for-dj fork uses "tidal_dl_ng-dev" config folder)
RUN pip3 install --upgrade tidal-dl-ng-for-dj

# ==================== Builder Stage ====================
FROM base AS builder

WORKDIR /app

# Copy package files (workspaces setup)
COPY package.json yarn.lock ./
COPY api/package.json ./api/
COPY app/package.json ./app/

# Install all workspace dependencies from root lockfile
RUN yarn install --frozen-lockfile

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
RUN mkdir -p /config /downloads /library /app \
    && chown -R node:node /config /downloads /library /app

# Copy package files (workspaces setup)
COPY --chown=node:node package.json yarn.lock ./
COPY --chown=node:node api/package.json ./api/
COPY --chown=node:node app/package.json ./app/

# Install production dependencies from root lockfile
RUN yarn install --frozen-lockfile --production

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
# tidal-dl-ng-for-dj uses /config/tidal_dl_ng-dev for its config

# Declare volumes for persistent data
VOLUME ["/config", "/library"]

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3737') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run production server
CMD ["node", "--experimental-specifier-resolution=node", "api/dist/index.js"]
