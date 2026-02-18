FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sim/package.json packages/sim/
COPY apps/client/package.json apps/client/
COPY services/server/package.json services/server/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY packages/sim packages/sim
COPY apps/client apps/client
COPY services/server services/server

# Build client
RUN cd apps/client && bun run build

# ── Production stage ──────────────────────────────────────
FROM oven/bun:1
WORKDIR /app

# Copy sim (pure TS, zero deps)
COPY --from=builder /app/packages/sim packages/sim

# Copy server source
COPY --from=builder /app/services/server services/server

# Copy built client into server's public dir
COPY --from=builder /app/apps/client/dist services/server/public

# Symlink workspace package (sim has zero npm deps, no install needed)
RUN mkdir -p node_modules/@chickenz && ln -s /app/packages/sim node_modules/@chickenz/sim

EXPOSE 3000
CMD ["bun", "services/server/src/index.ts"]
