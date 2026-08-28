# syntax=docker/dockerfile:1.7
FROM node:25-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY database ./database
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY scripts ./scripts
COPY tests ./tests
COPY vitest.integration.config.ts ./vitest.integration.config.ts
COPY vitest.system-archive-e2e.config.ts ./vitest.system-archive-e2e.config.ts
COPY pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM build AS production-dependencies
RUN CI=true pnpm prune --prod

FROM node:25-bookworm-slim AS runtime
ARG NEXUS_VERSION=0.1.0
ARG NEXUS_BUILD_COMMIT
ARG NEXUS_BUILD_DATE
ENV NODE_ENV=production \
    NEXUS_VERSION=${NEXUS_VERSION} \
    NEXUS_BUILD_COMMIT=${NEXUS_BUILD_COMMIT} \
    NEXUS_BUILD_DATE=${NEXUS_BUILD_DATE} \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080 \
    LEGACY_WEB_ROOT=/app/apps/web/dist \
    NEXT_WEB_ROOT=/app/apps/web-next/dist \
    MIGRATION_DIRECTORY=/app/database/migrations \
    ASSET_STORAGE_ROOT=/var/lib/infinitequest/assets \
    ARCHIVE_STORAGE_ROOT=/var/lib/infinitequest/archives
WORKDIR /app
RUN groupadd --system --gid 10001 infinitequest \
    && useradd --system --uid 10001 --gid infinitequest --home-dir /app infinitequest \
    && mkdir -p /var/lib/infinitequest/assets /var/lib/infinitequest/archives /var/lib/infinitequest/secrets \
    && chown -R infinitequest:infinitequest /var/lib/infinitequest /app
COPY --from=production-dependencies --chown=infinitequest:infinitequest /app/node_modules ./node_modules
COPY --from=build --chown=infinitequest:infinitequest /app/dist ./dist
COPY --from=build --chown=infinitequest:infinitequest /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=infinitequest:infinitequest /app/dist/packages/contracts/src ./packages/contracts/src
COPY --from=build --chown=infinitequest:infinitequest /app/database/migrations ./database/migrations
COPY --from=build --chown=infinitequest:infinitequest /app/scripts ./scripts
COPY --from=build --chown=infinitequest:infinitequest /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=infinitequest:infinitequest /app/apps/web-next/dist ./apps/web-next/dist
USER infinitequest
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/services/runtime/src/main.js"]
