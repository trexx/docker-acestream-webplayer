FROM bash:latest@sha256:a19c811ee9e97fa8a080001d82b8e0ded303f0795cffdb1cbd162731bc8ce208 AS website

COPY ./player /app

RUN apk add --no-cache gzip
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.html'

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /
