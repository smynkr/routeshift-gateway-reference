# ---------- base ----------
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.6.0 --activate

# ---------- deps ----------
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/proxy/package.json apps/proxy/
RUN pnpm install --frozen-lockfile

# ---------- build ----------
FROM base AS build
WORKDIR /app
COPY --from=deps /app .
COPY packages/shared packages/shared
COPY apps/proxy apps/proxy
RUN pnpm --filter @routeshift/shared build && pnpm --filter @routeshift/proxy build

# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app/apps/proxy
ENV NODE_ENV=production

# Copy built output + migrations where bundled code expects them
COPY --from=build /app/apps/proxy/dist ./dist
COPY --from=build /app/apps/proxy/src/db/migrations ./dist/migrations
COPY --from=build /app/apps/proxy/package.json ./package.json

# Copy runtime deps and shared package
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/proxy/node_modules ./node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/package.json /app/package.json

# Recreate workspace symlink for @routeshift/shared
RUN mkdir -p /app/node_modules/@routeshift && \
    rm -rf /app/node_modules/@routeshift/shared && \
    ln -s /app/packages/shared /app/node_modules/@routeshift/shared

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 proxy
USER proxy

EXPOSE 4000
CMD ["node", "dist/index.js"]
