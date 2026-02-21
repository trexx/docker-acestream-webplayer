FROM bash:latest AS website

COPY ./player /app/player

RUN apk add --no-cache gzip
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.{html,js}'

# Compile scratch image
FROM ghcr.io/trexx/docker-busybox-httpd:latest AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /www/
