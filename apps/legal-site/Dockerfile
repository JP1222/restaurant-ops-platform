# syntax=docker/dockerfile:1.7

# Stage 1: render the markdown sources to HTML using the zero-dependency
# build script. No npm install needed — apps/legal-site has no runtime deps.
FROM node:24-alpine AS build

WORKDIR /app

# The repo-level `.dockerignore` excludes `docs/` by default; legal-site
# explicitly re-includes `docs/legal/` via `!docs/legal` so this COPY
# can see the markdown source. If a future change removes that
# negation, this stage breaks with `"/docs/legal": not found`.
COPY apps/legal-site/src apps/legal-site/src
COPY docs/legal docs/legal

RUN node apps/legal-site/src/build.mjs

# Stage 2: serve the generated HTML with nginx. The healthcheck in the
# compose file uses curl, so bake it in (mirrors kds-web / backoffice-web).
FROM nginx:alpine AS runtime

RUN apk add --no-cache curl

COPY apps/legal-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/legal-site/dist /usr/share/nginx/html

EXPOSE 80
