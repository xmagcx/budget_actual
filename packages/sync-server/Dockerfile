# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.21.1

FROM node:${NODE_VERSION}-bookworm AS builder

WORKDIR /app

# Native deps for optional package builds (argon2/bcrypt, etc)
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      node-gyp \
      pkg-config \
      python-is-python3 \
      openssl && \
    rm -rf /var/lib/apt/lists/*

# Yarn 4 via Corepack (repo uses workspaces + workspace:* protocol)
RUN corepack enable

# Monorepo files required by workspaces install/focus
COPY .yarn ./.yarn
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages ./packages

# Install all deps from lockfile and then focus runtime deps for sync-server
RUN yarn install --immutable
RUN yarn workspace @actual-app/sync-server run build
RUN yarn workspaces focus @actual-app/sync-server --production

# Dereference workspace symlinks so runtime stage can copy node_modules only
RUN cp -RL node_modules node_modules.real \
    && rm -rf node_modules \
    && mv node_modules.real node_modules

# Trim dev/test folders from dereferenced workspace packages
RUN find node_modules/@actual-app -maxdepth 2 -type d \
    \( -name src -o -name e2e -o -name __tests__ -o -name __mocks__ -o -name tests -o -name test -o -name build-stats \) \
    -exec rm -rf {} +

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y tini && \
    rm -rf /var/lib/apt/lists/*

# Non-root runtime user
ARG USERNAME=actual
ARG USER_UID=1001
ARG USER_GID=${USER_UID}
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USERNAME}

# Data volume expected by sync-server
RUN mkdir -p /data && chown -R ${USERNAME}:${USERNAME} /data
VOLUME /data

# Flatten sync-server runtime layout to /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/sync-server/package.json ./
COPY --from=builder /app/packages/sync-server/build ./

# Backward compatibility for scripts path expected by health-check tooling
RUN mkdir -p src && ln -s ../scripts src/scripts

USER ${USERNAME}
EXPOSE 5006
ENTRYPOINT ["/usr/bin/tini","-g","--"]
CMD ["node","app.js"]
