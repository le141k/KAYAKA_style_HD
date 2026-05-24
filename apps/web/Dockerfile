# 23 Telecom Help Desk — Web (Next.js 15) multi-stage image.
# Build context = repo root (npm workspaces). Requires next.config with output:'standalone'.
#
# Base image pinned to a specific minor version. Review and update periodically
# (check https://hub.docker.com/_/node for newer 22.x-alpine releases).

FROM node:22.13-alpine AS deps
WORKDIR /app
# all workspace manifests are needed for `npm install` to resolve the workspace graph
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install

FROM node:22.13-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* is inlined at build time, so the browser API base URL must be a
# build arg (the runtime compose `environment:` has no effect on it). Defaults to
# localhost for dev; prod passes the public API origin via build args.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace=apps/web

FROM node:22.13-alpine AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# Run as the unprivileged built-in `node` user.
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
