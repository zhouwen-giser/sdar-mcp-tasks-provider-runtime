# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY apps/home-assistant-light-provider/package.json apps/home-assistant-light-provider/package.json
COPY packages/adapter-protocol/package.json packages/adapter-protocol/package.json
COPY packages/conformance-testkit/package.json packages/conformance-testkit/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/mcp-protocol/package.json packages/mcp-protocol/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/operation-registry/package.json packages/operation-registry/package.json
COPY packages/persistence-postgres/package.json packages/persistence-postgres/package.json
COPY packages/task-engine/package.json packages/task-engine/package.json
COPY examples/mock-adapter-typescript/package.json examples/mock-adapter-typescript/package.json
COPY examples/mock-adapter-python/package.json examples/mock-adapter-python/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS production-dependencies
RUN CI=true pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /workspace/node_modules /app/node_modules
COPY --from=build /workspace/dist /app/dist
COPY --from=build /workspace/proto /app/proto
COPY --from=build /workspace/migrations /app/migrations
RUN mkdir -p /var/lib/sdar && chown node:node /var/lib/sdar
USER node
CMD ["node", "dist/apps/runtime/src/main.js"]

FROM runtime AS adapter-ts
CMD ["node", "dist/examples/mock-adapter-typescript/src/main.js"]

FROM runtime AS home-assistant-light-provider
CMD ["node", "dist/apps/home-assistant-light-provider/src/main.js"]
