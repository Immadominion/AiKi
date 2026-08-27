# The API and the evidence scheduler ship as one image; the command decides which
# one a container becomes, so both always run identical code.
FROM node:24-alpine AS base
# Installed globally rather than through corepack. Corepack caches the package
# manager under the invoking user's home, so preparing it as root and then
# running as `node` sends the container back to the registry on every start,
# which races the platform's healthcheck and reads exactly like a crash. A
# global install lands in /usr/local/bin, where every user can see it.
RUN npm install -g pnpm@11.22.0
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @aiki/api...

FROM base AS runtime
ENV NODE_ENV=production
# pnpm 10+ checks node_modules against the lockfile before running any script and
# reinstalls when they disagree. This image installs a filtered subset on purpose,
# so that check always disagrees, and it turned every pre-deploy into an install
# that failed with no useful error. The dependencies are already here and correct.
ENV npm_config_verify_deps_before_run=false
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api

# Never run as root: the prober fetches arbitrary third-party URLs, so this
# process is the one most worth confining.
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@aiki/api", "start"]
