FROM node:22-alpine AS builder
RUN corepack enable

WORKDIR /app

# Copy entire repo
COPY package.json package-lock.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Install all deps (including devDependencies for build)
RUN npm install --workspaces --include-workspace-root

# Build server and client
RUN npm run build -w server && npm run build -w client

# Runtime image - everything we need is in the builder
FROM node:22-alpine

WORKDIR /app

# Copy pruned node_modules (only production deps)
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/shared/types.ts shared/types.ts
COPY --from=builder /app/shared/package.json shared/
COPY --from=builder /app/client/dist client/dist
COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/server/package.json server/

WORKDIR /app/server

# Data directory for SQLite
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=3001
ENV ENCRYPTION_KEY=placeholder

EXPOSE 3001

CMD ["node", "dist/index.js"]
