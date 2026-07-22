# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Install pnpm
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifest files first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.json tsconfig.base.json ./

# Copy source packages
COPY lib/      ./lib/
COPY scripts/  ./scripts/
COPY artifacts/api-server/   ./artifacts/api-server/
COPY artifacts/admin-panel/  ./artifacts/admin-panel/

# Install all dependencies
# onlyBuiltDependencies in pnpm-workspace.yaml already whitelists
# bufferutil, onnxruntime-node, utf-8-validate, esbuild, etc.
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# ── Build Admin Panel ─────────────────────────────────────────────────────────
# PORT is required by the vite config check (only used for dev server,
# not for `vite build`, but the config reads it unconditionally).
# BASE_PATH=/ because the SPA is served at the root in production.
RUN PORT=3000 BASE_PATH=/ NODE_ENV=production \
    pnpm --filter @workspace/admin-panel run build

# Copy Admin Panel output into the path the API server serves as static files.
# API server: path.resolve(__dirname, "..", "public")  →  artifacts/api-server/public/
RUN mkdir -p artifacts/api-server/public && \
    cp -r artifacts/admin-panel/dist/public/. artifacts/api-server/public/

# ── Build API Server ──────────────────────────────────────────────────────────
RUN pnpm --filter @workspace/api-server run build

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app/artifacts/api-server

# Copy compiled server bundle + static frontend
COPY --from=builder /app/artifacts/api-server/dist    ./dist
COPY --from=builder /app/artifacts/api-server/public  ./public
COPY --from=builder /app/artifacts/api-server/model.onnx ./model.onnx

# Copy root node_modules (contains native packages: sharp, onnxruntime-node, etc.)
COPY --from=builder /app/node_modules ../../node_modules

# Copy package-level node_modules when pnpm hoisted them per-package
# (RUN allows the optional copy to silently succeed even if the dir is empty)
RUN --mount=type=bind,from=builder,source=/app/artifacts/api-server/node_modules,target=/tmp/pkg_nm \
    cp -r /tmp/pkg_nm/. ./node_modules/ 2>/dev/null || true

ENV NODE_ENV=production
# PORT defaults to 8080; platforms like Railway/Render inject their own PORT
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
