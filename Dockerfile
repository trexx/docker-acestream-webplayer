FROM bash:latest AS website

# renovate: datasource=npm depName=mpegts.js
ENV MPEGTS_VERSION="1.8.0"

COPY ./player /app

RUN apk add --no-cache curl gzip
RUN curl -fsSL "https://registry.npmjs.org/mpegts.js/-/mpegts.js-${MPEGTS_VERSION}.tgz" \
      | tar -xzOf - package/dist/mpegts.js > /app/mpegts.js
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.{html,js}'

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /
