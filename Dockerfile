# ---- Builder Stage ----
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/

# Copy the specific service's package.json (set by ARG)
ARG SERVICE_NAME
COPY services/${SERVICE_NAME}/package.json ./services/${SERVICE_NAME}/
COPY services/${SERVICE_NAME}/tsconfig.json ./services/${SERVICE_NAME}/

# Install all deps (dev deps needed for build)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY services/${SERVICE_NAME}/src ./services/${SERVICE_NAME}/src
COPY services/${SERVICE_NAME}/tsconfig.json ./services/${SERVICE_NAME}/

# Build shared package first, then the service
RUN pnpm --filter @taskqueue/shared build
RUN pnpm --filter @taskqueue/${SERVICE_NAME} build

# Prune dev deps
RUN pnpm prune --prod

# ---- Runner Stage ----
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}
ENV NODE_ENV=production

# Copy built artifacts and production deps from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/services/${SERVICE_NAME}/dist ./services/${SERVICE_NAME}/dist
COPY --from=builder /app/services/${SERVICE_NAME}/package.json ./services/${SERVICE_NAME}/

# Copy migrations if this is the state-manager
COPY --from=builder /app/services/${SERVICE_NAME}/migrations ./services/${SERVICE_NAME}/migrations 2>/dev/null || true

USER node

EXPOSE 3000

CMD ["node", "services/${SERVICE_NAME}/dist/index.js"]
