FROM bash:latest@sha256:d07824ed325ed1faa6b54f9413f92c5b7acdd600f90d780904ed09a8d72a8d20 AS website

COPY ./player /app

RUN apk add --no-cache gzip
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.html'

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /
