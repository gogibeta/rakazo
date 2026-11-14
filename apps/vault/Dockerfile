FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
# Prisma's migration engine detects and links against OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.cjs ./
COPY patches patches
COPY packages/adapter-kit packages/adapter-kit
COPY packages/adapters packages/adapters
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/logging packages/logging
COPY packages/page-kit packages/page-kit
COPY packages/ui-tokens packages/ui-tokens
COPY apps/vault apps/vault
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/vault..."
RUN pnpm --filter @rakazo/db generate
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /app/apps/vault
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
