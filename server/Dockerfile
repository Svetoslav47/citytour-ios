# syntax=docker/dockerfile:1
# CityTour course server (docs/SERVER.md §7). Build context = the REPOSITORY ROOT, because the image also carries
# the courses' pack + clip files (data/course/<courseId>/, each laid out like its manifest paths: tour/... (or the
# older packs/<id>/...), audio/...) and the city packs (data/city/<cityId>/: city.json, pois.json, narrations/...)
# that the committed signed seed (server/seed) points at:   docker build -f server/Dockerfile -t citytour-server .
# Signing happens on the maintainer's machine (npm run publish-course); the private key is never in the image.

FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
# su-exec: the entrypoint fixes the ownership of a freshly mounted volume, then drops to the non-root user.
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/var/data \
    SEED_DIR=/app/seed \
    SEED_FILES_DIR=/app/seed-files \
    SEED_CITY_FILES_DIR=/app/seed-city-files
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./package.json
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY server/seed ./seed
COPY data/course ./seed-files
COPY data/city ./seed-city-files
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /var/data && chown node:node /var/data \
 && chown -R root:root /app && chmod -R a+rX,go-w /app
VOLUME ["/var/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
