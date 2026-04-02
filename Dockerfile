FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config and lockfiles
COPY package.json pnpm-lock.yaml ./
COPY packages/sim/package.json packages/sim/
COPY apps/client/package.json apps/client/
COPY services/server/package.json services/server/

# Install dependencies (bun can read pnpm-lock.yaml)
RUN bun install

# Copy source
COPY packages/sim packages/sim
COPY apps/client apps/client
COPY services/server services/server

# Copy pre-built WASM pkg (built locally via: cd services/prover/wasm && wasm-pack build --target web)
COPY services/prover/wasm/pkg services/prover/wasm/pkg

# Build client
RUN cd apps/client && bun run build

# ── Production stage ──────────────────────────────────────
FROM oven/bun:1
WORKDIR /app

# Run as non-root user
RUN adduser --disabled-password --gecos "" chickenz
USER chickenz

# Copy sim (pure TS, zero deps)
COPY --from=builder --chown=chickenz /app/packages/sim packages/sim

# Copy server source
COPY --from=builder --chown=chickenz /app/services/server services/server

# Copy WASM pkg (server loads from services/prover/wasm/pkg/)
COPY --from=builder --chown=chickenz /app/services/prover/wasm/pkg services/prover/wasm/pkg

# Copy built client into server's public dir
COPY --from=builder --chown=chickenz /app/apps/client/dist services/server/public

# Symlink workspace package (sim has zero npm deps, no install needed)
RUN mkdir -p node_modules/@chickenz && ln -s /app/packages/sim node_modules/@chickenz/sim

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun eval "fetch('http://localhost:3000/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "services/server/src/index.ts"]
