# 23 Telecom Help Desk — API (NestJS) multi-stage image.
# Build context = repo root (npm workspaces).
#
# Base image pinned to a specific minor version. Review and update periodically
# (check https://hub.docker.com/_/node for newer 22.x-alpine releases).

FROM node:22.23.1-alpine3.23 AS deps
WORKDIR /app
# all workspace manifests are needed for `npm install` to resolve the workspace graph
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=optional

FROM node:22.23.1-alpine3.23 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm workspaces may place API-specific packages under the workspace (not root).
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN npx -w apps/api prisma generate \
  && npm run build --workspace=apps/api

# Production-only dependencies — no vitest/eslint/tsc/testcontainers in the runtime image.
FROM node:22.23.1-alpine3.23 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --omit=optional

FROM node:22.23.1-alpine3.23 AS runner
ENV NODE_ENV=production
WORKDIR /app
# Keep only the workspace manifests in the runtime image. The deploy helper runs
# `npm audit --package-lock-only` in this exact pinned image, avoiding a host-NPM
# version/network prerequisite while never copying deployment environment files.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Prod deps only (prisma CLI is now a prod dep so `migrate deploy` works at boot)…
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
# …plus the Prisma client generated during the build stage (prisma generate runs there).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
# Run as the unprivileged built-in `node` user. Pre-create the uploads dir owned
# by node so the named volume mounted there is writable without root.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
WORKDIR /app/apps/api
USER node
EXPOSE 4000
# migrations + seed + start are orchestrated by docker-compose `command`.
CMD ["node", "dist/main.js"]
