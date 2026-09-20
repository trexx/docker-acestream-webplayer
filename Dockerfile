FROM bash:latest@sha256:61962062d969cb46dfc2bad061d36342406fa485f64f246aa7e95693ca07df1f AS website

COPY ./player /app

RUN apk add --no-cache gzip
RUN /usr/bin/env bash -O globstar -c 'gzip -9 /app/**/*.html'

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-ace-player"

COPY --from=website /app /
