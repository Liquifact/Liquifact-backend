# =============================================================================
# Stage 1 — dependency installer
# =============================================================================
# Uses the full node:20-slim image to install production dependencies from the
# committed package-lock.json.  Using `npm ci` (rather than `npm install`)
# ensures the install is reproducible: it fails immediately if package-lock.json
# is absent or out of sync with package.json, which closes the supply-chain gap
# of installing undeclared transitive versions.
# =============================================================================
FROM node:20-slim AS deps

WORKDIR /app

# Copy only the manifest files first so Docker layer-caching skips the
# npm ci step on subsequent builds when no dependencies changed.
COPY package.json package-lock.json ./

# --omit=dev   → production deps only; keeps node_modules lean.
# --frozen-lockfile is the npm ci default, but is stated explicitly here for
# clarity: the build will fail if package-lock.json is missing or diverged.
RUN npm ci --omit=dev

# =============================================================================
# Stage 2 — production runtime
# =============================================================================
# Copies only the already-installed node_modules and application source from
# the deps stage.  No compiler toolchain, no npm, no build secrets survive
# into the final image.
# =============================================================================
FROM node:20-slim AS runtime

# ── Security hardening: non-root user ────────────────────────────────────────
# Create a dedicated system group and user with no home directory, no shell,
# and no password.  The container process will run as UID/GID 1001, not root.
# Running as root is a CIS Docker Benchmark Level-1 finding (DI-05).
RUN groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /bin/false appuser

WORKDIR /app

# Copy the pruned node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source.  Files excluded by .dockerignore are never sent to
# the build context, so secrets and dev artefacts never enter this layer.
COPY . .

# ── Ownership hand-off ────────────────────────────────────────────────────────
# Recursively give the non-root user ownership of /app so the process can read
# logs, write temp files, and open the SQLite dev DB without elevation.
# node_modules are chowned here too; they arrived from the deps stage as root.
RUN chown -R appuser:appgroup /app

# ── Environment ───────────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=3001

# Expose the API port (documentation only; actual binding is done by the
# runtime host/orchestrator).
EXPOSE 3001

# ── Drop privileges ───────────────────────────────────────────────────────────
# Switch to the non-root user for all subsequent instructions and the CMD.
# Every process spawned by CMD inherits this identity.
USER appuser

# ── Health check ──────────────────────────────────────────────────────────────
# Polls the /readyz readiness probe that the application exposes.
# --start-period gives the server time to finish DB migrations before the
# first check; failures before that window do not count against --retries.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/readyz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# ── Entrypoint ────────────────────────────────────────────────────────────────
CMD ["node", "src/index.js"]
