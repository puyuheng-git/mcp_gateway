FROM node:24-alpine AS pnpm

WORKDIR /app
RUN npm install --global pnpm@11.23.0

FROM pnpm AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM pnpm AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ca-certificates git openssh-client docker-cli \
    && mkdir -p /app/var/audit \
    && chown node:node /app/var/audit \
    && chmod 0700 /app/var/audit

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config

USER node:node
EXPOSE 3000
CMD ["node", "dist/main.js"]
