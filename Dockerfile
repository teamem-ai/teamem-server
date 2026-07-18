# teamem portal — production image (AGPL-3.0-only)
#
# Multi-stage build: builder compiles the monorepo, runtime carries only
# production artifacts. The same image serves both the HTTP server and the
# pg-boss compile worker; the entrypoint differs via docker-compose CMD.
#
# Build:  docker compose build
# Shell:  docker compose run --rm server sh

# ── Stage 1: builder ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# Workspace definition files — pnpm needs these to resolve workspace deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# @teamem/schema: consumed as TypeScript source (no build step, main → src/index.ts).
COPY packages/schema/package.json packages/schema/
COPY packages/schema/src packages/schema/src

# @teamem/server: the primary build target.
COPY apps/server/package.json apps/server/
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/tsup.config.ts apps/server/
COPY apps/server/src apps/server/src

# Install all deps (including dev for tsup build), then build.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @teamem/server build

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache curl
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# Workspace definition files for pnpm workspace resolution at runtime.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Schema source — the compiled server.js imports "@teamem/schema", which
# resolves to packages/schema/src/index.ts via the workspace link.
COPY --from=builder /app/packages/schema ./packages/schema

# Server artifacts — dist/ (compiled) + package.json (workspace identity).
COPY apps/server/package.json apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Production-only dependencies (workspace links + node_modules).
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080

CMD ["node", "apps/server/dist/server.js"]
