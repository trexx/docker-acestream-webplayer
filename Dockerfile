FROM bash:latest@sha256:b44c25360c4af785f74b4535467be3a68b6c770bbd1332df4b31f4b7b92503b3 AS website

COPY ./player /app

RUN apk add --no-cache gzip
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.html'

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /
