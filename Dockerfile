# reference: https://bun.com/docs/guides/ecosystem/docker
FROM oven/bun:latest AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock /app/
RUN  bun install --frozen-lockfile --production

FROM base AS build
COPY . .
COPY --from=install /app/node_modules ./node_modules
RUN bun run build

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
