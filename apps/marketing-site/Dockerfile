# syntax=docker/dockerfile:1.7

# Stage 1: run the zero-dependency build script that copies src/ into dist/.
# No npm install needed — apps/marketing-site has no runtime deps.
FROM node:24-alpine AS build

WORKDIR /app

COPY apps/marketing-site/src apps/marketing-site/src

RUN node apps/marketing-site/src/build.mjs

# Stage 2: serve the generated static files with nginx. The healthcheck in the
# compose file uses curl, so bake it in (mirrors kds-web / backoffice-web /
# legal-site).
FROM nginx:alpine AS runtime

RUN apk add --no-cache curl

COPY apps/marketing-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/marketing-site/dist /usr/share/nginx/html

EXPOSE 80
