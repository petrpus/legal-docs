# Deploy-ready image for the @petrpus/legal-docs demo (render tab, theme editor, clause editor, diff).
#
# Build context MUST be the repo root (the demo consumes ../../dist and ../../legal-docs):
#   docker build -f examples/demo/Dockerfile -t legal-docs-demo .
#   docker run -p 8080:8080 legal-docs-demo

# ---- builder: build the library, then the demo client ----
FROM node:22-slim AS builder
WORKDIR /app

# Dependencies before source so the npm-install layer only invalidates on a package.json/lock change,
# not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY legal-docs ./legal-docs
RUN npm run build

COPY examples/demo/package.json examples/demo/package-lock.json ./examples/demo/
RUN cd examples/demo && npm ci
COPY examples/demo/tsconfig.json examples/demo/vite.config.ts examples/demo/index.html ./examples/demo/
COPY examples/demo/src ./examples/demo/src
COPY examples/demo/server ./examples/demo/server
RUN cd examples/demo && npm run build

# ---- runtime: only what server.mjs needs at request time ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production-only root deps (@react-pdf/renderer, docx, jsep, react, yaml, zod) — tsup externalizes
# these, so they must be present at runtime; devDependencies (vitest, eslint, tsup, …) are skipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/legal-docs ./legal-docs
COPY --from=builder /app/examples/demo/dist ./examples/demo/dist
# The bundled PDF fonts (assets/fonts/*.ttf) are resolved at runtime relative to the package root
# (fonts.ts's packageRoot(), which walks up from dist/ looking for package.json) — not bundled into
# dist/*.js, so they must be copied here explicitly.
COPY assets ./assets
COPY examples/demo/server ./examples/demo/server
COPY examples/demo/server.mjs ./examples/demo/server.mjs

EXPOSE 8080
CMD ["node", "examples/demo/server.mjs"]
