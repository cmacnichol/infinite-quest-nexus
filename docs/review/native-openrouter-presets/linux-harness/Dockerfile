FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")"
COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY database ./database
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY scripts ./scripts
COPY tests ./tests
COPY vitest.integration.config.ts vitest.system-archive-e2e.config.ts ./
COPY docs/installation/environment-configuration.md ./docs/installation/environment-configuration.md
COPY docs/review/native-openrouter-presets/linux-harness/vitest.config.mjs ./docs/review/native-openrouter-presets/linux-harness/vitest.config.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps chromium
RUN pnpm build
CMD ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "docs/review/native-openrouter-presets/linux-harness/vitest.config.mjs"]
