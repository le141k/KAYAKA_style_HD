# 23 Telecom Help Desk — API (NestJS) multi-stage image.
# Build context = repo root (npm workspaces).

FROM node:22-alpine AS deps
WORKDIR /app
# all workspace manifests are needed for `npm install` to resolve the workspace graph
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx -w apps/api prisma generate \
  && npm run build --workspace=apps/api

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/package.json ./package.json
EXPOSE 4000
# migrations + seed + start are orchestrated by docker-compose `command`.
CMD ["node", "dist/main.js"]
