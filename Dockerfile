# syntax=docker/dockerfile:1

# Pin the multi-platform base image by both version and manifest digest so the
# build and runtime stages cannot silently drift to a different Node release.
ARG NODE_IMAGE=node:22.17.0-alpine3.22@sha256:fc3e945f920b7e3000cd1af86c4ae406ec70c72f328b667baf0f3a8910d69eed

FROM ${NODE_IMAGE} AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace


FROM base AS dependencies

# Copy dependency manifests separately so source changes can reuse the frozen
# dependency layer. The lockfile and exact packageManager version make installs
# deterministic.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/schema/package.json packages/schema/package.json

RUN pnpm install --frozen-lockfile


FROM dependencies AS build

COPY . .

# The built server externalizes pg, while the current workspace manifest still
# classifies it as a dev dependency. pg-boss already installs the exact locked
# pg package in the production graph, so expose that package at the app root.
RUN pnpm build \
    && pnpm --filter @teamem/server deploy --prod --legacy /production/server \
    && ln -s .pnpm/pg@8.22.0/node_modules/pg /production/server/node_modules/pg


FROM ${NODE_IMAGE} AS runtime

# docker-compose uses curl for its service healthcheck. Installing it in the
# runtime image also keeps the Dockerfile HEALTHCHECK usable without Node code.
ARG CURL_VERSION=8.14.1-r3
RUN apk add --no-cache "curl=${CURL_VERSION}"

ENV NODE_ENV=production
ENV TEAMEM_PORT=8080

WORKDIR /app

# Keep only compiled entrypoints and the deployed production dependency graph.
# Both the server composition root and worker.js are copied from the same build.
COPY --from=build --chown=node:node /production/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /production/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /workspace/apps/server/dist ./apps/server/dist

USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:${TEAMEM_PORT}/healthz || exit 1

CMD ["node", "apps/server/dist/index.js"]
