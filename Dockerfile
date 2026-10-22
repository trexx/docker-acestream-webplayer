FROM alpine:3.24@sha256:c6b073f8e9e58d881f6ffba6ebf3b9ebd60b9e7d6e8337018c0e68bb5c356873 AS website

COPY ./player /app

# busybox gzip, already in the base image. The plain file is deliberately not
# kept: busybox httpd serves index.html.gz to any client that accepts gzip,
# which every browser does.
RUN find /app -name '*.html' -exec gzip -9 {} +

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-acestream-webplayer"

COPY --from=website /app /
