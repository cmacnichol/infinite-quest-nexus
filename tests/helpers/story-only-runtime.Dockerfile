FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")"
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY database ./database
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY scripts ./scripts
COPY tests ./tests
RUN pnpm install --frozen-lockfile
ARG VITE_UI_COMPONENTS=native
RUN pnpm run build:web:legacy && VITE_UI_COMPONENTS=$VITE_UI_COMPONENTS pnpm run build:web:next
EXPOSE 8080 8081
