# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY database ./database
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY tests ./tests
COPY vitest.integration.config.ts ./vitest.integration.config.ts
COPY pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM build AS production-dependencies
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ARG NEXUS_VERSION=0.1.0
ARG NEXUS_BUILD_COMMIT
ARG NEXUS_BUILD_DATE
ENV NODE_ENV=production \
    NEXUS_VERSION=${NEXUS_VERSION} \
    NEXUS_BUILD_COMMIT=${NEXUS_BUILD_COMMIT} \
    NEXUS_BUILD_DATE=${NEXUS_BUILD_DATE} \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080 \
    WEB_ROOT=/app/apps/web/public \
    MIGRATION_DIRECTORY=/app/database/migrations \
    ASSET_STORAGE_ROOT=/var/lib/infinitequest/assets
WORKDIR /app
RUN groupadd --system --gid 10001 infinitequest \
    && useradd --system --uid 10001 --gid infinitequest --home-dir /app infinitequest \
    && mkdir -p /var/lib/infinitequest/assets \
    && chown -R infinitequest:infinitequest /var/lib/infinitequest /app
COPY --from=production-dependencies --chown=infinitequest:infinitequest /app/node_modules ./node_modules
COPY --from=build --chown=infinitequest:infinitequest /app/dist ./dist
COPY --from=build --chown=infinitequest:infinitequest /app/database/migrations ./database/migrations
COPY --from=build --chown=infinitequest:infinitequest /app/apps/web/public ./apps/web/public
USER infinitequest
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/services/runtime/src/main.js"]
