# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/adapter-protocol/package.json packages/adapter-protocol/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY examples/mock-adapter-typescript/package.json examples/mock-adapter-typescript/package.json
COPY examples/mock-adapter-python/package.json examples/mock-adapter-python/package.json
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/node_modules /app/node_modules
COPY --from=build /workspace/dist /app/dist
COPY --from=build /workspace/proto /app/proto
CMD ["node", "dist/apps/runtime/src/main.js"]

FROM runtime AS adapter-ts
CMD ["node", "dist/examples/mock-adapter-typescript/src/main.js"]
